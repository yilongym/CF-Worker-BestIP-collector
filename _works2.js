export default {
  async scheduled(event, env, ctx) {
    console.log('Running scheduled IP update...');
    await updateAllIPs(env);
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
          if (request.method !== 'POST') {
            return jsonResponse({ error: 'Method not allowed' }, 405);
          }
          return await handleUpdate(env);
        case '/ips':
        case '/ip.txt':
          // 原有接口：只返回 IP，换行分隔
          return await handleGetIPs(env);
        case '/ips-format':
          // 新接口：返回 IP:端口#国家
          return await handleGetFormattedIPs(env);
        case '/raw':
          return await handleRawIPs(env);
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

// 提供HTML页面
async function serveHTML(env) {
  const data = await getStoredIPs(env);
  
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Cloudflare IP 收集器</title>
    <style>
        * { 
            margin: 0; 
            padding: 0; 
            box-sizing: border-box; 
        }
        
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
            line-height: 1.6; 
            background: #f8fafc;
            color: #334155;
            min-height: 100vh;
            padding: 20px;
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
        }
        
        /* 头部和社交图标 */
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 40px;
            padding-bottom: 20px;
            border-bottom: 1px solid #e2e8f0;
        }
        
        .header-content h1 {
            font-size: 2.5rem;
            background: linear-gradient(135deg, #3b82f6 0%, #06b6d4 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 8px;
            font-weight: 700;
        }
        
        .header-content p {
            color: #64748b;
            font-size: 1.1rem;
        }
        
        .social-links {
            display: flex;
            gap: 15px;
        }
        
        .social-link {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 44px;
            height: 44px;
            border-radius: 12px;
            background: white;
            border: 1px solid #e2e8f0;
            transition: all 0.3s ease;
            text-decoration: none;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
        }
        
        .social-link:hover {
            background: #f8fafc;
            transform: translateY(-2px);
            border-color: #cbd5e1;
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
        }
        
        .social-link.youtube { color: #dc2626; }
        .social-link.youtube:hover { background: #fef2f2; border-color: #fecaca; }
        
        .social-link.github { color: #1f2937; }
        .social-link.github:hover { background: #f8fafc; border-color: #cbd5e1; }
        
        .social-link.telegram { color: #3b82f6; }
        .social-link.telegram:hover { background: #eff6ff; border-color: #bfdbfe; }
        
        /* 卡片设计 */
        .card {
            background: white;
            border-radius: 16px;
            padding: 30px;
            margin-bottom: 24px;
            border: 1px solid #e2e8f0;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);
        }
        
        .card h2 {
            font-size: 1.5rem;
            color: #1e40af;
            margin-bottom: 20px;
            font-weight: 600;
        }
        
        /* 统计数字 */
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 16px;
            margin-bottom: 24px;
        }
        
        .stat {
            background: #f8fafc;
            padding: 20px;
            border-radius: 12px;
            text-align: center;
            border: 1px solid #e2e8f0;
        }
        
        .stat-value {
            font-size: 2rem;
            font-weight: 700;
            color: #3b82f6;
            margin-bottom: 8px;
        }
        
        /* 按钮组 */
        .button-group {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
            margin-bottom: 20px;
        }
        
        .button {
            padding: 12px 20px;
            border: none;
            border-radius: 10px;
            font-size: 0.95rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
            text-decoration: none;
            display: inline-flex;
            align-items: center;
            gap: 8px;
            background: #3b82f6;
            color: white;
            border: 1px solid #3b82f6;
        }
        
        .button:hover {
            background: #2563eb;
            border-color: #2563eb;
            transform: translateY(-1px);
            box-shadow: 0 4px 8px rgba(59, 130, 246, 0.3);
        }
        
        .button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: none;
            box-shadow: none;
        }
        
        .button-success { background: #10b981; border-color: #10b981; }
        .button-success:hover { background: #059669; border-color: #059669; }
        
        .button-warning { background: #f59e0b; border-color: #f59e0b; }
        .button-warning:hover { background: #d97706; border-color: #d97706; }
        
        .button-secondary { background: white; color: #475569; border-color: #cbd5e1; }
        .button-secondary:hover { background: #f8fafc; border-color: #94a3b8; }
        
        .button-purple { background: #8b5cf6; border-color: #8b5cf6; }
        .button-purple:hover { background: #7c3aed; border-color: #7c3aed; }
        
        /* IP 列表 */
        .ip-list-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            flex-wrap: wrap;
            gap: 15px;
        }
        
        .ip-list {
            background: #f8fafc;
            border-radius: 12px;
            padding: 20px;
            max-height: 500px;
            overflow-y: auto;
            border: 1px solid #e2e8f0;
        }
        
        .ip-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px 16px;
            border-bottom: 1px solid #e2e8f0;
            transition: background 0.3s ease;
        }
        
        .ip-item:hover { background: #f1f5f9; }
        .ip-item:last-child { border-bottom: none; }
        
        .ip-info {
            display: flex;
            align-items: center;
            gap: 16px;
        }
        
        .ip-address {
            font-family: 'SF Mono', 'Courier New', monospace;
            font-weight: 600;
            min-width: 140px;
            color: #1e293b;
        }

        .ip-country {
            font-size: 0.9rem;
            color: #64748b;
            display: flex;
            align-items: center;
            gap: 4px;
            min-width: 50px;
        }
        
        .speed-result {
            font-size: 0.85rem;
            padding: 4px 12px;
            border-radius: 8px;
            background: #e2e8f0;
            min-width: 70px;
            text-align: center;
            font-weight: 600;
        }
        
        .speed-fast { background: #d1fae5; color: #065f46; }
        .speed-medium { background: #fef3c7; color: #92400e; }
        .speed-slow { background: #fee2e2; color: #991b1b; }
        
        .action-buttons {
            display: flex;
            gap: 8px;
        }
        
        .small-btn {
            padding: 6px 12px;
            border-radius: 8px;
            font-size: 0.8rem;
            border: 1px solid #cbd5e1;
            background: white;
            color: #475569;
            cursor: pointer;
            transition: all 0.3s ease;
        }
        
        .small-btn:hover { background: #f8fafc; border-color: #94a3b8; }
        .small-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        
        /* 加载和状态 */
        .loading {
            display: none;
            text-align: center;
            padding: 30px;
        }
        
        .spinner {
            border: 3px solid #e2e8f0;
            border-top: 3px solid #3b82f6;
            border-radius: 50%;
            width: 40px;
            height: 40px;
            animation: spin 1s linear infinite;
            margin: 0 auto 16px;
        }
        
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        
        .result {
            margin: 20px 0;
            padding: 16px 20px;
            border-radius: 12px;
            display: none;
            border-left: 4px solid;
        }
        
        .success { background: #d1fae5; color: #065f46; border-left-color: #10b981; }
        .error { background: #fee2e2; color: #991b1b; border-left-color: #ef4444; }
        
        /* 进度条 */
        .speed-test-progress {
            margin: 16px 0;
            background: #e2e8f0;
            border-radius: 8px;
            height: 8px;
            overflow: hidden;
            display: none;
        }
        
        .speed-test-progress-bar {
            background: linear-gradient(90deg, #3b82f6, #06b6d4);
            height: 100%;
            width: 0%;
            transition: width 0.3s ease;
        }
        
        /* 数据来源 */
        .sources { display: grid; gap: 12px; }
        .source {
            padding: 12px 16px;
            background: #f8fafc;
            border-radius: 8px;
            border-left: 4px solid #10b981;
        }
        .source.error { border-left-color: #ef4444; }
        
        /* 页脚 */
        .footer {
            text-align: center;
            margin-top: 40px;
            padding-top: 30px;
            border-top: 1px solid #e2e8f0;
            color: #64748b;
        }
        
        /* 模态框 */
        .modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.5);
            backdrop-filter: blur(5px);
            z-index: 1000;
            justify-content: center;
            align-items: center;
        }
        
        .modal-content {
            background: white;
            padding: 30px;
            border-radius: 16px;
            max-width: 500px;
            width: 90%;
            border: 1px solid #e2e8f0;
            box-shadow: 0 20px 25px rgba(0, 0, 0, 0.1);
        }
        
        .modal h3 { margin-bottom: 16px; color: #1e40af; }
        .modal-buttons {
            display: flex;
            gap: 12px;
            justify-content: flex-end;
            margin-top: 20px;
        }
        
        @media (max-width: 768px) {
            .header { flex-direction: column; gap: 20px; text-align: center; }
            .button-group { flex-direction: column; }
            .button { width: 100%; justify-content: center; }
            .ip-item { flex-direction: column; align-items: flex-start; gap: 12px; }
            .ip-info { width: 100%; justify-content: space-between; }
            .action-buttons { width: 100%; justify-content: flex-end; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="header-content">
                <h1>🌐 Cloudflare IP 收集器</h1>
                <p>网络加速专家 | 智能测速与优化</p>
            </div>
            <div class="social-links">
                <a href="https://youtu.be/rZl2jz--Oes" target="_blank" class="social-link youtube">
                     <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.546 12 3.546 12 3.546s-7.505 0-9.377.504A3.016 3.016 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.504 9.376.504 9.376.504s7.505 0 9.377-.504a3.016 3.016 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12 9.545 15.568z"/></svg>
                </a>
                <a href="https://github.com/ethgan/CF-Worker-BestIP-collector" target="_blank" class="social-link github">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.085 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
                </a>
                <a href="https://t.me/yt_hytj" target="_blank" class="social-link telegram">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="m7.06510669 16.9258959c5.22739451-2.1065178 8.71314291-3.4952633 10.45724521-4.1662364 4.9797665-1.9157646 6.0145193-2.2485535 6.6889567-2.2595423.1483363-.0024169.480005.0315855.6948461.192827.1814076.1361492.23132.3200675.2552048.4491519.0238847.1290844.0536269.4231419.0299841.65291-.2698553 2.6225356-1.4375148 8.986738-2.0315537 11.9240228-.2513602 1.2428753-.7499132 1.5088847-1.2290685 1.5496672-1.0413153.0886298-1.8284257-.4857912-2.8369905-1.0972863-1.5782048-.9568691-2.5327083-1.3984317-4.0646293-2.3321592-1.7703998-1.0790837-.212559-1.583655.7963867-2.5529189.2640459-.2536609 4.7753906-4.3097041 4.755976-4.431706-.0070494-.0442984-.1409018-.481649-.2457499-.5678447-.104848-.0861957-.2595946-.0567202-.3712641-.033278-.1582881.0332286-2.6794907 1.5745492-7.5636077 4.6239616-.715635.4545193-1.3638349.6759763-1.9445998.6643712-.64024672-.0127938-1.87182452-.334829-2.78737602-.6100966-1.12296117-.3376271-1.53748501-.4966332-1.45976769-1.0700283.04048-.2986597.32581586-.610598.8560076-.935815z"/></svg>
                </a>
            </div>
        </div>

        <div class="card">
            <h2>📊 系统状态</h2>
            <div class="stats">
                <div class="stat">
                    <div class="stat-value" id="ip-count">${data.count || 0}</div>
                    <div>IP 地址数量</div>
                </div>
                <div class="stat">
                    <div class="stat-value" id="last-updated">${data.lastUpdated ? '已更新' : '未更新'}</div>
                    <div>最后更新</div>
                </div>
                <div class="stat">
                    <div class="stat-value" id="last-time">${data.lastUpdated ? new Date(data.lastUpdated).toLocaleTimeString() : '从未更新'}</div>
                    <div>更新时间</div>
                </div>
            </div>
            
            <div class="button-group">
                <button class="button" onclick="updateIPs()" id="update-btn">🔄 立即更新</button>
                <a href="/ips" class="button button-success" download="cloudflare_ips.txt">📥 下载列表</a>
                <a href="/ips-format" class="button button-purple" target="_blank">📄 格式化列表 (IP:Port#国别)</a>
                <a href="/ip.txt" class="button button-secondary" target="_blank">🔗 查看纯文本</a>
                <button class="button button-warning" onclick="startSpeedTest()" id="speedtest-btn">⚡ 开始测速</button>
                <button class="button" onclick="openItdogModal()">🌐 ITDog 测速</button>
            </div>
            
            <div class="loading" id="loading">
                <div class="spinner"></div>
                <p>正在收集 IP 地址并分析地理位置，这可能需要几十秒...</p>
            </div>
            
            <div class="result" id="result"></div>
        </div>

        <div class="card">
            <div class="ip-list-header">
                <h2>📋 IP 地址列表</h2>
                <div>
                    <button class="small-btn" onclick="copyAllIPs()">📋 复制全部</button>
                    <button class="small-btn" onclick="sortBySpeed()" id="sort-btn">🔽 按速度排序</button>
                </div>
            </div>
            
            <div class="speed-test-progress" id="speed-test-progress">
                <div class="speed-test-progress-bar" id="speed-test-progress-bar"></div>
            </div>
            <div style="text-align: center; margin: 8px 0; font-size: 0.9rem; color: #64748b;" id="speed-test-status">准备测速...</div>
            
            <div class="ip-list" id="ip-list">
                ${renderIPList(data.ips)}
            </div>
        </div>

        <div class="card">
            <h2>🌍 数据来源状态</h2>
            <div class="sources" id="sources">
                ${data.sources ? data.sources.map(source => `
                    <div class="source ${source.status === 'success' ? '' : 'error'}">
                        <strong>${source.name}</strong>: 
                        ${source.status === 'success' ? 
                          `成功获取 ${source.count} 个IP` : 
                          `失败: ${source.error}`
                        }
                    </div>
                `).join('') : '<p style="color: #64748b;">暂无数据来源信息</p>'}
            </div>
        </div>

        <div class="footer">
            <p>Cloudflare IP Collector &copy; ${new Date().getFullYear()} | With Geolocation</p>
        </div>
    </div>

    <div class="modal" id="itdog-modal">
        <div class="modal-content">
            <h3>🌐 ITDog 批量 TCPing 测速</h3>
            <p>ITDog.cn 提供了从多个国内监测点进行 TCPing 测速的功能。</p>
            <div class="modal-buttons">
                <button class="button button-secondary" onclick="closeItdogModal()">取消</button>
                <button class="button" onclick="copyIPsForItdog()">复制 IP 列表</button>
                <a href="https://www.itdog.cn/batch_tcping/" class="button button-success" target="_blank">打开 ITDog</a>
            </div>
        </div>
    </div>

    <script>
        let speedResults = {};
        let isTesting = false;

        // 国旗代码转换
        function getFlagEmoji(countryCode) {
          if (!countryCode || countryCode === 'UNK') return '🏳️';
          const codePoints = countryCode
            .toUpperCase()
            .split('')
            .map(char =>  127397 + char.charCodeAt());
          return String.fromCodePoint(...codePoints);
        }

        function showMessage(message, type = 'success') {
            const result = document.getElementById('result');
            result.className = \`result \${type}\`;
            result.innerHTML = \`<p>\${message}</p>\`;
            result.style.display = 'block';
            setTimeout(() => { result.style.display = 'none'; }, 3000);
        }

        function openItdogModal() { document.getElementById('itdog-modal').style.display = 'flex'; }
        function closeItdogModal() { document.getElementById('itdog-modal').style.display = 'none'; }

        async function copyIPsForItdog() {
            try {
                const response = await fetch('/itdog-data');
                const data = await response.json();
                if (data.ips && data.ips.length > 0) {
                    await navigator.clipboard.writeText(data.ips.join('\\n'));
                    showMessage('已复制 IP 列表');
                    closeItdogModal();
                }
            } catch (error) { showMessage('获取 IP 列表失败', 'error'); }
        }

        function copyIP(ip) {
            navigator.clipboard.writeText(ip).then(() => showMessage(\`已复制: \${ip}\`));
        }

        function copyAllIPs() {
            const ipItems = document.querySelectorAll('.ip-item');
            const allIPs = Array.from(ipItems).map(item => item.dataset.ip).join('\\n');
            if (!allIPs) return showMessage('没有可复制的IP地址', 'error');
            navigator.clipboard.writeText(allIPs).then(() => showMessage(\`已复制 \${ipItems.length} 个IP地址\`));
        }

        async function testSingleIP(ip) {
            const testBtn = document.getElementById(\`test-\${ip.replace(/\./g, '-')}\`);
            const speedElement = document.getElementById(\`speed-\${ip.replace(/\./g, '-')}\`);
            const countryElement = document.getElementById(\`country-\${ip.replace(/\./g, '-')}\`);
            
            testBtn.disabled = true;
            testBtn.textContent = '...';
            
            try {
                const startTime = performance.now();
                const response = await fetch(\`/speedtest?ip=\${ip}\`);
                const data = await response.json();
                const latency = performance.now() - startTime;
                
                speedResults[ip] = { latency: latency, success: data.success };
                
                if (data.success) {
                    const speedClass = latency < 200 ? 'speed-fast' : latency < 500 ? 'speed-medium' : 'speed-slow';
                    speedElement.textContent = \`\${Math.round(latency)}ms\`;
                    speedElement.className = \`speed-result \${speedClass}\`;
                    
                    // 如果测速返回了真实的Colo国家，更新显示
                    if (data.colo && data.loc) {
                         const flag = getFlagEmoji(data.loc);
                         countryElement.innerHTML = \`\${flag} \${data.loc}\`;
                    }
                } else {
                    speedElement.textContent = '失败';
                    speedElement.className = 'speed-result speed-slow';
                }
            } catch (error) {
                speedElement.textContent = 'Err';
                speedElement.className = 'speed-result speed-slow';
            } finally {
                testBtn.disabled = false;
                testBtn.textContent = '测速';
            }
        }

        async function startSpeedTest() {
            if (isTesting) return;
            
            const ipItems = document.querySelectorAll('.ip-item');
            if (ipItems.length === 0) return showMessage('没有IP可测', 'error');
            
            const btn = document.getElementById('speedtest-btn');
            const progressBar = document.getElementById('speed-test-progress');
            const progressBarInner = document.getElementById('speed-test-progress-bar');
            const statusElement = document.getElementById('speed-test-status');
            
            isTesting = true;
            btn.disabled = true;
            progressBar.style.display = 'block';
            
            // 并发控制：每次5个
            const CONCURRENCY = 5;
            const ips = Array.from(ipItems).map(item => item.dataset.ip);
            let completed = 0;
            
            for (let i = 0; i < ips.length; i += CONCURRENCY) {
                const batch = ips.slice(i, i + CONCURRENCY);
                await Promise.all(batch.map(async (ip) => {
                    await testSingleIP(ip);
                    completed++;
                    const progress = (completed / ips.length) * 100;
                    progressBarInner.style.width = \`\${progress}%\`;
                    statusElement.textContent = \`正在测速: \${completed}/\${ips.length}\`;
                }));
            }
            
            isTesting = false;
            btn.disabled = false;
            progressBar.style.display = 'none';
            statusElement.textContent = '测速完成';
            sortBySpeed();
        }

        function sortBySpeed() {
            const list = document.getElementById('ip-list');
            const items = Array.from(list.children);
            
            items.sort((a, b) => {
                const resA = speedResults[a.dataset.ip];
                const resB = speedResults[b.dataset.ip];
                if (resA && resB) return resA.latency - resB.latency;
                if (resA) return -1;
                if (resB) return 1;
                return 0;
            });
            
            items.forEach(item => list.appendChild(item));
        }

        async function updateIPs() {
            const btn = document.getElementById('update-btn');
            const loading = document.getElementById('loading');
            const result = document.getElementById('result');
            
            btn.disabled = true;
            loading.style.display = 'block';
            result.style.display = 'none';
            
            try {
                const response = await fetch('/update', { method: 'POST' });
                const data = await response.json();
                
                if (data.success) {
                    showMessage(\`更新成功！收集到 \${data.totalIPs} 个IP，耗时 \${data.duration}\`);
                    setTimeout(() => location.reload(), 1500); 
                } else {
                    showMessage(data.error || '更新失败', 'error');
                }
            } catch (error) {
                showMessage(error.message, 'error');
            } finally {
                btn.disabled = false;
                loading.style.display = 'none';
            }
        }
        
        // 初始化
        function getFlagEmoji(countryCode) {
            if (!countryCode || countryCode === 'UNK') return '🏳️';
            const codePoints = countryCode.toUpperCase().split('').map(char => 127397 + char.charCodeAt());
            return String.fromCodePoint(...codePoints);
        }
    </script>
</body>
</html>`;
  
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// 辅助函数：渲染 IP 列表
function renderIPList(ips) {
    if (!ips || ips.length === 0) {
        return '<p style="text-align: center; color: #64748b; padding: 40px;">暂无 IP 数据</p>';
    }
    
    // 兼容旧数据结构 (string[]) 和新数据结构 ({ip, country}[])
    return ips.map(item => {
        const ip = typeof item === 'string' ? item : item.ip;
        const country = typeof item === 'string' ? 'UNK' : (item.country || 'UNK');
        const flag = getFlagEmoji(country);
        const ipId = ip.replace(/\./g, '-');
        
        return `
        <div class="ip-item" data-ip="${ip}">
            <div class="ip-info">
                <span class="ip-address">${ip}</span>
                <span class="ip-country" id="country-${ipId}">${flag} ${country}</span>
                <span class="speed-result" id="speed-${ipId}">-</span>
            </div>
            <div class="action-buttons">
                <button class="small-btn" onclick="testSingleIP('${ip}')" id="test-${ipId}">测速</button>
                <button class="small-btn" onclick="copyIP('${ip}')">复制</button>
            </div>
        </div>`;
    }).join('');
}

function getFlagEmoji(countryCode) {
    if (!countryCode || countryCode === 'UNK') return '🏳️';
    const codePoints = countryCode.toUpperCase().split('').map(char => 127397 + char.charCodeAt());
    return String.fromCodePoint(...codePoints);
}

// 处理 ITDog 数据
async function handleItdogData(env) {
  const data = await getStoredIPs(env);
  const ipsOnly = data.ips.map(i => typeof i === 'string' ? i : i.ip);
  return jsonResponse({ ips: ipsOnly, count: data.count });
}

// 处理测速请求 - 改用 trace 获取更准确的信息
async function handleSpeedTest(request, env) {
  const url = new URL(request.url);
  const ip = url.searchParams.get('ip');
  
  if (!ip) return jsonResponse({ error: 'IP required' }, 400);
  
  try {
    // 使用 trace 接口，既能测活，又能看该 IP 实际路由到了哪里
    // 注意：这里我们请求 cloudflare.com/cdn-cgi/trace，并强制解析到目标 IP
    const response = await fetch('https://1.1.1.1/cdn-cgi/trace', {
      headers: { 'Host': '1.1.1.1' }, // Host 并不重要，重要的是 resolveOverride
      cf: { resolveOverride: ip }
    });
    
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const text = await response.text();
    // 解析 trace 结果
    const lines = text.split('\n');
    const data = {};
    lines.forEach(line => {
      const [key, value] = line.split('=');
      if (key && value) data[key] = value;
    });
    
    return jsonResponse({
      success: true,
      ip: ip,
      loc: data.loc || 'UNK', // Country Code
      colo: data.colo || 'UNK' // Airport Code
    });
    
  } catch (error) {
    return jsonResponse({ success: false, error: error.message }, 500);
  }
}

// 处理手动更新
async function handleUpdate(env) {
  try {
    if (!env.IP_STORAGE) throw new Error('KV Not Bound');

    const startTime = Date.now();
    const { uniqueIPs, results } = await updateAllIPs(env);
    
    // 存储结构升级：包含 IP 和 Country
    await env.IP_STORAGE.put('cloudflare_ips', JSON.stringify({
      ips: uniqueIPs, // [{ip: '1.1.1.1', country: 'US'}, ...]
      lastUpdated: new Date().toISOString(),
      count: uniqueIPs.length,
      sources: results
    }));

    return jsonResponse({
      success: true,
      duration: `${Date.now() - startTime}ms`,
      totalIPs: uniqueIPs.length,
      results: results
    });
  } catch (error) {
    return jsonResponse({ success: false, error: error.message }, 500);
  }
}

// 获取纯文本列表 (仅IP)
async function handleGetIPs(env) {
  const data = await getStoredIPs(env);
  // 兼容旧数据 (string) 和新数据 (object)
  const ipList = data.ips.map(item => typeof item === 'string' ? item : item.ip);
  
  return new Response(ipList.join('\n'), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// 获取格式化列表 (IP:Port#Country)
async function handleGetFormattedIPs(env) {
  const data = await getStoredIPs(env);
  
  const formattedList = data.ips.map(item => {
    let ip, country;
    if (typeof item === 'string') {
      ip = item;
      country = 'UNK';
    } else {
      ip = item.ip;
      country = item.country || 'UNK';
    }
    return `${ip}:443#${country}`;
  });

  return new Response(formattedList.join('\n'), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// 获取原始 JSON
async function handleRawIPs(env) {
  const data = await getStoredIPs(env);
  return jsonResponse(data);
}

// IP 收集与地理位置查询逻辑
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

  // 3. 批量查询归属地 (使用 ip-api.com batch 接口)
  // 注意：ip-api 免费版限制 45次请求/分，每个batch最多100个IP。
  const ipObjects = [];
  const BATCH_SIZE = 100;
  
  for (let i = 0; i < ipArray.length; i += BATCH_SIZE) {
    const batch = ipArray.slice(i, i + BATCH_SIZE);
    try {
      // 这里的 API 查询是获取 IP 注册地
      const geoResp = await fetch('http://ip-api.com/batch', {
        method: 'POST',
        body: JSON.stringify(batch),
        headers: { 'Content-Type': 'application/json' }
      });
      
      if (geoResp.ok) {
        const geoData = await geoResp.json();
        // 映射结果
        geoData.forEach(item => {
          ipObjects.push({
            ip: item.query,
            country: item.status === 'success' ? item.countryCode : 'UNK'
          });
        });
      } else {
        // API 失败回退
        batch.forEach(ip => ipObjects.push({ ip, country: 'UNK' }));
      }
      
      // 简单延迟防止速率限制
      if (i + BATCH_SIZE < ipArray.length) await new Promise(r => setTimeout(r, 1000));
      
    } catch (e) {
      console.error('Geo lookup failed:', e);
      batch.forEach(ip => ipObjects.push({ ip, country: 'UNK' }));
    }
  }

  return { uniqueIPs: ipObjects, results: results };
}

function getSourceName(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

async function getStoredIPs(env) {
  try {
    const data = await env.IP_STORAGE.get('cloudflare_ips');
    if (data) return JSON.parse(data);
  } catch (e) { console.error(e); }
  return { ips: [], lastUpdated: null, count: 0 };
}

function isValidIPv4(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every(part => {
    const n = parseInt(part, 10);
    return n >= 0 && n <= 255;
  }) && !ip.startsWith('10.') && !ip.startsWith('127.') && !ip.startsWith('192.168.');
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
