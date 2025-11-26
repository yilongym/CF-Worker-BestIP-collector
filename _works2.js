// =================配置区域=================
const FAST_IP_COUNT = 25; // 自定义保留的优质IP数量
// =========================================

export default {
  async scheduled(event, env, ctx) {
    console.log('Running scheduled IP update...');
    await performUpdate(env);
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // 检查 KV 是否绑定
    if (!env.IP_STORAGE) {
      return new Response('KV namespace IP_STORAGE is not bound. Please bind it in Worker settings.', {
        status: 500,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
    
    if (request.method === 'OPTIONS') {
      return handleCORS();
    }

    try {
      switch (path) {
        case '/':
          return await serveHTML(env);
        case '/update':
          if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
          return await handleManualUpdate(env);
        
        // --- 获取全部 IP 接口 ---
        case '/ips':
        case '/ip.txt':
          return await handleGetIPs(env); // 纯IP列表
        case '/ips-format':
          return await handleGetFormattedIPs(env); // IP:端口#国家
        case '/raw':
          return await handleRawIPs(env); // 原始JSON
        
        // --- 获取优质 IP 接口 ---
        case '/fast-ips':
          return await handleGetFastIPs(env); // JSON格式
        case '/fast-ips.txt':
          return await handleGetFastIPsText(env); // 文本格式 (IP:端口#国家_延迟)

        // --- 功能接口 ---
        case '/speedtest':
          return await handleSpeedTest(request, env);
        case '/itdog-data':
          return await handleItdogData(env);
          
        default:
          return jsonResponse({ error: 'Endpoint not found' }, 404);
      }
    } catch (error) {
      console.error('Error:', error);
      return jsonResponse({ error: error.message }, 500);
    }
  }
};

// ================= 核心逻辑 =================

// 执行完整的更新流程：收集 -> 存储 -> 测速 -> 存储优质IP
async function performUpdate(env) {
    const startTime = Date.now();
    
    // 1. 收集并获取地理位置
    const { uniqueIPs, results } = await updateAllIPs(env);
    
    // 2. 存储全量数据
    await env.IP_STORAGE.put('cloudflare_ips', JSON.stringify({
      ips: uniqueIPs, // [{ip: '1.1.1.1', country: 'US'}, ...]
      lastUpdated: new Date().toISOString(),
      count: uniqueIPs.length,
      sources: results
    }));

    // 3. 自动测速并筛选优质IP
    const fastIPs = await autoSpeedTestAndStore(env, uniqueIPs);
    
    return {
        duration: `${Date.now() - startTime}ms`,
        totalIPs: uniqueIPs.length,
        fastIPsCount: fastIPs.length,
        results: results
    };
}

// 自动测速并存储优质IP
async function autoSpeedTestAndStore(env, ips) {
    if (!ips || ips.length === 0) return [];

    // 为了效率，只对前 150 个 IP 进行测速 (通常前面的IP质量较好，或者随机抽取)
    // 这里我们打乱数组取前 100 个，避免每次都测一样的
    const shuffled = ips.slice().sort(() => 0.5 - Math.random());
    const ipsToTest = shuffled.slice(0, 100);
    
    const speedResults = [];
    const BATCH_SIZE = 5; // 并发数

    console.log(`Starting auto speed test for ${ipsToTest.length} IPs...`);

    for (let i = 0; i < ipsToTest.length; i += BATCH_SIZE) {
      const batch = ipsToTest.slice(i, i + BATCH_SIZE);
      const promises = batch.map(item => testIPSpeed(item.ip, item.country));
      
      const results = await Promise.allSettled(promises);
      
      results.forEach(res => {
          if (res.status === 'fulfilled' && res.value.success) {
              speedResults.push(res.value);
          }
      });
      
      // 简单防频控延迟
      if (i + BATCH_SIZE < ipsToTest.length) await new Promise(r => setTimeout(r, 500));
    }

    // 按延迟排序
    speedResults.sort((a, b) => a.latency - b.latency);
    
    // 截取前 FAST_IP_COUNT 个
    const fastIPs = speedResults.slice(0, FAST_IP_COUNT);

    // 存储优质IP
    await env.IP_STORAGE.put('cloudflare_fast_ips', JSON.stringify({
      fastIPs: fastIPs,
      lastTested: new Date().toISOString(),
      count: fastIPs.length
    }));

    return fastIPs;
}

// 单个IP测速逻辑 (使用 Trace)
async function testIPSpeed(ip, knownCountry = 'UNK') {
    const startTime = Date.now();
    try {
        // 使用 resolveOverride 强制指定 IP
        const response = await fetch('https://1.1.1.1/cdn-cgi/trace', {
            headers: { 'Host': '1.1.1.1' },
            cf: { resolveOverride: ip },
            signal: AbortSignal.timeout(3000) // 3秒超时
        });

        if (!response.ok) throw new Error('Network error');
        
        const text = await response.text();
        const latency = Date.now() - startTime;

        // 解析 Trace 结果获取真实 Colo 和 Loc
        const data = {};
        text.split('\n').forEach(line => {
            const [k, v] = line.split('=');
            if(k) data[k] = v;
        });

        return {
            success: true,
            ip: ip,
            latency: latency,
            country: data.loc || knownCountry, // 优先使用测速返回的真实Loc
            colo: data.colo || 'UNK'
        };
    } catch (e) {
        return { success: false, ip, error: e.message };
    }
}

// IP 收集与地理位置查询逻辑 (保留原有的 geo 查询)
async function updateAllIPs(env) {
  const urls = [
    'https://ip.164746.xyz', 
    'https://ip.haogege.xyz/',
    'https://cf.090227.xyz/ct/',
    'https://api.uouin.com/cloudflare.html',
    'https://raw.githubusercontent.com/946727185/auto-ip-update/refs/heads/main/bendituisong.txt'
  ];

  const ipSet = new Set();
  const results = [];
  const ipPattern = /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/gi;

  // 1. 收集 IP
  for (const url of urls) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      
      if (resp.ok) {
        const text = await resp.text();
        const matches = text.match(ipPattern) || [];
        matches.forEach(ip => {
            if(isValidIPv4(ip)) ipSet.add(ip);
        });
        results.push({ name: getSourceName(url), status: 'success', count: matches.length });
      } else {
          throw new Error(resp.statusText);
      }
    } catch (e) {
      results.push({ name: getSourceName(url), status: 'error', error: e.message });
    }
  }

  // 2. 转换为数组并排序
  let ipArray = Array.from(ipSet).sort((a, b) => {
    const pA = a.split('.').map(Number);
    const pB = b.split('.').map(Number);
    for (let i = 0; i < 4; i++) if (pA[i] !== pB[i]) return pA[i] - pB[i];
    return 0;
  });

  // 3. 批量查询归属地
  const ipObjects = [];
  const BATCH_SIZE = 100;
  
  for (let i = 0; i < ipArray.length; i += BATCH_SIZE) {
    const batch = ipArray.slice(i, i + BATCH_SIZE);
    try {
      const geoResp = await fetch('http://ip-api.com/batch', {
        method: 'POST',
        body: JSON.stringify(batch),
        headers: { 'Content-Type': 'application/json' }
      });
      
      if (geoResp.ok) {
        const geoData = await geoResp.json();
        geoData.forEach(item => {
          ipObjects.push({
            ip: item.query,
            country: item.status === 'success' ? item.countryCode : 'UNK'
          });
        });
      } else {
        batch.forEach(ip => ipObjects.push({ ip, country: 'UNK' }));
      }
      if (i + BATCH_SIZE < ipArray.length) await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      batch.forEach(ip => ipObjects.push({ ip, country: 'UNK' }));
    }
  }

  return { uniqueIPs: ipObjects, results: results };
}


// ================= 接口处理 =================

async function handleManualUpdate(env) {
    try {
        const result = await performUpdate(env);
        return jsonResponse({
            success: true,
            ...result
        });
    } catch (error) {
        return jsonResponse({ success: false, error: error.message }, 500);
    }
}

// 获取全部 IP (纯文本)
async function handleGetIPs(env) {
  const data = await getStoredIPs(env);
  const ipList = data.ips.map(item => item.ip);
  return new Response(ipList.join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

// 获取全部 IP (格式化: IP:443#Country)
async function handleGetFormattedIPs(env) {
  const data = await getStoredIPs(env);
  const formattedList = data.ips.map(item => `${item.ip}:443#${item.country || 'UNK'}`);
  return new Response(formattedList.join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

// 获取优质 IP (JSON)
async function handleGetFastIPs(env) {
  const data = await getStoredSpeedIPs(env);
  return jsonResponse(data);
}

// 获取优质 IP (文本: IP:443#Country_Latency)
async function handleGetFastIPsText(env) {
  const data = await getStoredSpeedIPs(env);
  const list = (data.fastIPs || []).map(item => 
      `${item.ip}:443#${item.country || 'UNK'}_${Math.round(item.latency)}ms`
  );
  return new Response(list.join('\n'), { 
      headers: { 
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': 'inline; filename="fast_ips.txt"'
      } 
  });
}

// ITDog 数据
async function handleItdogData(env) {
  const data = await getStoredIPs(env);
  const ipsOnly = data.ips.map(i => i.ip);
  return jsonResponse({ ips: ipsOnly, count: data.count });
}

// 前端手动单点测速
async function handleSpeedTest(request, env) {
  const url = new URL(request.url);
  const ip = url.searchParams.get('ip');
  if (!ip) return jsonResponse({ error: 'IP required' }, 400);
  
  const result = await testIPSpeed(ip);
  return jsonResponse(result);
}

async function handleRawIPs(env) {
  const data = await getStoredIPs(env);
  return jsonResponse(data);
}

// ================= 数据读取辅助 =================

async function getStoredIPs(env) {
  try {
    const data = await env.IP_STORAGE.get('cloudflare_ips');
    return data ? JSON.parse(data) : { ips: [], count: 0 };
  } catch (e) { return { ips: [], count: 0 }; }
}

async function getStoredSpeedIPs(env) {
  try {
    const data = await env.IP_STORAGE.get('cloudflare_fast_ips');
    return data ? JSON.parse(data) : { fastIPs: [], count: 0 };
  } catch (e) { return { fastIPs: [], count: 0 }; }
}

// ================= 页面展示 =================

async function serveHTML(env) {
  const data = await getStoredIPs(env);
  const speedData = await getStoredSpeedIPs(env);
  const fastIPs = speedData.fastIPs || [];

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Cloudflare IP 优选 & 测速</title>
    <style>
        :root { --primary: #3b82f6; --bg: #f8fafc; --card: #ffffff; }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, system-ui, sans-serif; background: var(--bg); color: #334155; padding: 20px; line-height: 1.5; }
        .container { max-width: 1200px; margin: 0 auto; }
        
        /* Header */
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; border-bottom: 1px solid #e2e8f0; padding-bottom: 20px; }
        h1 { font-size: 2rem; background: linear-gradient(135deg, #3b82f6, #06b6d4); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .links a { margin-left: 10px; text-decoration: none; font-size: 1.2rem; }

        /* Cards */
        .card { background: var(--card); border-radius: 16px; padding: 25px; margin-bottom: 24px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); border: 1px solid #e2e8f0; }
        .card h2 { color: #1e40af; margin-bottom: 15px; display: flex; justify-content: space-between; align-items: center; }
        
        /* Stats */
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin-bottom: 20px; }
        .stat-box { background: #f1f5f9; padding: 15px; border-radius: 10px; text-align: center; }
        .stat-val { font-size: 1.8rem; font-weight: bold; color: var(--primary); }
        .stat-label { font-size: 0.9rem; color: #64748b; }

        /* Buttons */
        .btn-group { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 15px; }
        .btn { padding: 10px 18px; border-radius: 8px; border: none; font-weight: 600; cursor: pointer; text-decoration: none; color: white; background: var(--primary); transition: 0.2s; display: inline-flex; align-items: center; gap: 5px; font-size: 0.9rem; }
        .btn:hover { opacity: 0.9; transform: translateY(-1px); }
        .btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .btn-green { background: #10b981; }
        .btn-purple { background: #8b5cf6; }
        .btn-orange { background: #f59e0b; }
        .btn-gray { background: #fff; color: #475569; border: 1px solid #cbd5e1; }
        .btn-gray:hover { background: #f8fafc; }

        /* List */
        .ip-list { max-height: 400px; overflow-y: auto; background: #f8fafc; border-radius: 10px; border: 1px solid #e2e8f0; }
        .ip-item { display: flex; justify-content: space-between; align-items: center; padding: 10px 15px; border-bottom: 1px solid #e2e8f0; font-family: monospace; font-size: 0.95rem; }
        .ip-item:hover { background: #e2e8f0; }
        .ip-info { display: flex; gap: 15px; align-items: center; }
        .flag { font-style: normal; }
        
        /* Badge */
        .badge { padding: 3px 8px; border-radius: 4px; font-size: 0.8rem; font-weight: bold; }
        .badge-green { background: #dcfce7; color: #166534; }
        .badge-yellow { background: #fef9c3; color: #854d0e; }
        .badge-red { background: #fee2e2; color: #991b1b; }

        /* Loading */
        .loader { display: none; text-align: center; padding: 20px; color: #64748b; }
        .spinner { width: 30px; height: 30px; border: 3px solid #e2e8f0; border-top-color: var(--primary); border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 10px; }
        @keyframes spin { to { transform: rotate(360deg); } }
        
        /* Modal */
        .modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); align-items: center; justify-content: center; z-index: 100; }
        .modal-box { background: white; padding: 25px; border-radius: 16px; width: 90%; max-width: 400px; }

        @media (max-width: 600px) {
            .header { flex-direction: column; text-align: center; gap: 10px; }
            .ip-item { flex-direction: column; align-items: flex-start; gap: 8px; }
            .ip-actions { width: 100%; display: flex; justify-content: flex-end; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h1>☁️ Cloudflare IP 收集器</h1>
                <p style="color:#64748b">自动采集 · 智能测速 · 优选推荐</p>
            </div>
            <div class="links">
                <a href="https://github.com/ethgan/CF-Worker-BestIP-collector" target="_blank">📦</a>
            </div>
        </div>

        <div class="card">
            <h2>📊 系统状态</h2>
            <div class="stats">
                <div class="stat-box">
                    <div class="stat-val">${data.count}</div>
                    <div class="stat-label">总 IP 数量</div>
                </div>
                <div class="stat-box">
                    <div class="stat-val">${fastIPs.length}</div>
                    <div class="stat-label">优质 IP</div>
                </div>
                <div class="stat-box">
                    <div class="stat-val">${data.lastUpdated ? new Date(data.lastUpdated).toLocaleTimeString() : '-'}</div>
                    <div class="stat-label">上次更新</div>
                </div>
            </div>
            <div class="btn-group">
                <button class="btn" onclick="updateData()" id="updateBtn">🔄 立即更新 & 测速</button>
                <a href="/fast-ips.txt" target="_blank" class="btn btn-purple">⚡ 下载优质IP (文本)</a>
                <a href="/ips-format" target="_blank" class="btn btn-green">📄 下载全量IP (格式化)</a>
                <button class="btn btn-gray" onclick="showItdog()">🐶 ITDog 测速</button>
            </div>
            <div class="loader" id="loader">
                <div class="spinner"></div>
                <div id="loader-text">正在从多个源收集IP并进行智能测速，耗时约 10-20 秒...</div>
            </div>
        </div>

        <div class="card" style="border-left: 5px solid #8b5cf6;">
            <h2>
                <span>⚡ 优质 IP 推荐 <span style="font-size:0.8rem; color:#64748b; font-weight:normal">(自动筛选 Top ${FAST_IP_COUNT})</span></span>
                <button class="btn btn-gray" style="padding: 4px 8px; font-size: 0.8rem;" onclick="copyList('fast-list')">复制全部</button>
            </h2>
            <div class="ip-list" id="fast-list">
                ${fastIPs.length === 0 ? '<div style="padding:20px; text-align:center; color:#94a3b8">暂无数据，请点击立即更新</div>' : 
                  fastIPs.map(ip => renderRow(ip, true)).join('')}
            </div>
        </div>

        <div class="card">
            <h2>
                <span>📋 全部 IP 列表</span>
                <button class="btn btn-gray" style="padding: 4px 8px; font-size: 0.8rem;" onclick="copyList('full-list')">复制全部</button>
            </h2>
            <div class="ip-list" id="full-list">
                 ${data.ips.slice(0, 200).map(ip => renderRow(ip, false)).join('')}
                 ${data.ips.length > 200 ? '<div style="padding:10px; text-align:center; color:#94a3b8">仅显示前 200 个，请下载完整列表</div>' : ''}
            </div>
        </div>
        
        <div style="text-align: center; color: #cbd5e1; font-size: 0.8rem; margin-top: 40px;">
            Cloudflare IP Collector | Based on Workers
        </div>
    </div>

    <div class="modal" id="itdogModal">
        <div class="modal-box">
            <h3>🐶 ITDog 批量测速</h3>
            <p style="margin: 15px 0; color: #475569;">已生成纯 IP 列表，请复制后前往 ITDog 进行国内多地 Ping/TCP 测试。</p>
            <div style="display:flex; justify-content:flex-end; gap:10px;">
                <button class="btn btn-gray" onclick="document.getElementById('itdogModal').style.display='none'">关闭</button>
                <button class="btn" onclick="copyForItdog()">复制并前往</button>
            </div>
        </div>
    </div>

    <script>
        function getFlag(code) {
            if (!code || code === 'UNK') return '🏳️';
            return String.fromCodePoint(...code.toUpperCase().split('').map(c => 127397 + c.charCodeAt()));
        }

        async function updateData() {
            const btn = document.getElementById('updateBtn');
            const loader = document.getElementById('loader');
            btn.disabled = true;
            loader.style.display = 'block';
            
            try {
                const res = await fetch('/update', { method: 'POST' });
                const json = await res.json();
                if(json.success) {
                    alert('更新成功！发现 ' + json.totalIPs + ' 个IP，筛选出 ' + json.fastIPsCount + ' 个优质IP');
                    location.reload();
                } else {
                    alert('更新失败: ' + json.error);
                }
            } catch(e) { alert('请求错误'); }
            
            btn.disabled = false;
            loader.style.display = 'none';
        }

        function copy(text) {
            navigator.clipboard.writeText(text).then(() => {
                const toast = document.createElement('div');
                toast.textContent = '已复制: ' + text;
                toast.style.cssText = 'position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:rgba(0,0,0,0.8); color:white; padding:8px 16px; border-radius:20px; font-size:0.9rem;';
                document.body.appendChild(toast);
                setTimeout(() => toast.remove(), 2000);
            });
        }

        function copyList(id) {
            const list = document.getElementById(id);
            const ips = Array.from(list.querySelectorAll('.ip-val')).map(el => el.textContent).join('\\n');
            copy(ips);
        }

        async function copyForItdog() {
            const res = await fetch('/itdog-data');
            const json = await res.json();
            navigator.clipboard.writeText(json.ips.join('\\n'));
            window.open('https://www.itdog.cn/batch_tcping/', '_blank');
        }

        function showItdog() { document.getElementById('itdogModal').style.display = 'flex'; }
        
        // 前端单点测速
        async function testOne(ip, btn) {
            btn.textContent = '...';
            btn.disabled = true;
            try {
                const res = await fetch('/speedtest?ip=' + ip);
                const data = await res.json();
                if(data.success) {
                    btn.textContent = Math.round(data.latency) + 'ms';
                    btn.style.background = data.latency < 200 ? '#10b981' : '#f59e0b';
                    btn.style.color = 'white';
                } else {
                    btn.textContent = 'Err';
                    btn.style.background = '#ef4444';
                }
            } catch(e) { btn.textContent = 'Fail'; }
        }
    </script>
</body>
</html>`;

  // 简单的模板渲染辅助函数，为了减少重复代码
  // 注意：这里我们使用 replace 来注入JS函数 `getFlag` 的执行结果，但因为是SSR，
  // 我们直接在 Server 端生成 HTML 字符串比较方便。
  
  function renderRow(item, isFast) {
      const ip = isFast ? item.ip : (item.ip || item);
      const country = isFast ? item.country : (item.country || 'UNK');
      const latency = isFast ? Math.round(item.latency) + 'ms' : '-';
      const flag = getFlagEmoji(country);
      
      let badgeHtml = '';
      if(isFast) {
          const color = item.latency < 150 ? 'green' : (item.latency < 300 ? 'yellow' : 'red');
          badgeHtml = `<span class="badge badge-${color}">${latency}</span>`;
      } else {
          badgeHtml = `<button class="btn-gray" style="padding:2px 6px; font-size:0.75rem;" onclick="testOne('${ip}', this)">测速</button>`;
      }

      return `
      <div class="ip-item">
          <div class="ip-info">
              <span class="flag">${flag}</span>
              <span class="ip-val" style="font-weight:600">${ip}</span>
              <span style="color:#94a3b8; font-size:0.8rem">${country}</span>
          </div>
          <div class="ip-actions" style="display:flex; align-items:center; gap:10px">
              ${badgeHtml}
              <button class="btn-gray" style="padding:2px 6px; font-size:0.75rem;" onclick="copy('${ip}')">复制</button>
          </div>
      </div>`;
  }

  return new Response(html.replace('function renderRow', ''), { 
      headers: { 'Content-Type': 'text/html; charset=utf-8' } 
  });
}

// 辅助函数
function getSourceName(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function isValidIPv4(ip) {
  return /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(ip);
}

function getFlagEmoji(countryCode) {
    if (!countryCode || countryCode === 'UNK') return '🏳️';
    return String.fromCodePoint(...countryCode.toUpperCase().split('').map(c => 127397 + c.charCodeAt()));
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

function handleCORS() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
