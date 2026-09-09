/* ===== 云原生工具 ===== */
(function () {
  'use strict';
  var LB = window.LB, U = LB.util, D = LB.data;

  /* ---------- 1. K8s YAML 生成器 ---------- */
  LB.register({
    id: 'k8syaml', cat: 'cloud', icon: '☸️', name: 'K8s YAML 生成器',
    desc: '可视化生成 Deployment / Service / Ingress 等清单',
    kw: 'k8s kubernetes yaml deployment service ingress configmap 生成',
    tpl: function () {
      return '<div class="tabs" id="ktab">' +
        ['deploy:Deployment', 'svc:Service', 'ing:Ingress', 'cm:ConfigMap', 'pvc:PVC', 'cron:CronJob']
          .map(function (x, i) { return '<button class="tab' + (i === 0 ? ' on' : '') + '" data-m="' + x.split(':')[0] + '">' + x.split(':')[1] + '</button>'; }).join('') +
        '</div>' +
        '<div class="pane-k" id="k-deploy">' + deployForm() + '</div>' +
        '<div class="pane-k" id="k-svc" hidden>' + svcForm() + '</div>' +
        '<div class="pane-k" id="k-ing" hidden>' + ingForm() + '</div>' +
        '<div class="pane-k" id="k-cm" hidden>' + cmForm() + '</div>' +
        '<div class="pane-k" id="k-pvc" hidden>' + pvcForm() + '</div>' +
        '<div class="pane-k" id="k-cron" hidden>' + cronForm() + '</div>' +
        '<div class="t-section"><div class="sec-t">生成的 YAML</div>' + U.outBlock('k8sout') +
        '<div class="btn-group"><button class="btn btn-pri" id="k8sgo">生成</button>' +
        '<button class="btn btn-sm" id="k8sdl">下载 .yaml</button>' +
        '<button class="btn btn-sm" id="k8sapply">复制 apply 命令</button></div></div>';
      function deployForm() {
        return '<div class="t-section"><div class="sec-t">Deployment</div>' +
          '<div class="row tight">' +
          f('d-name', '应用名', 'nginx-demo', 'text') + f('d-ns', '命名空间', 'default', 'text') +
          f('d-rep', '副本数', '3', 'number') + f('d-img', '镜像', 'nginx:1.25-alpine', 'text') +
          f('d-port', '容器端口', '80', 'number') + f('d-policy', '拉取策略', 'IfNotPresent', 'text') + '</div>' +
          '<div class="field mt8"><label class="field-l">环境变量（每行 KEY=VALUE）</label>' +
          '<textarea id="d-env" style="min-height:70px">TZ=Asia/Shanghai\nLOG_LEVEL=info</textarea></div>' +
          '<div class="row tight">' + f('d-rcpu', 'CPU request', '100m', 'text') + f('d-lcpu', 'CPU limit', '500m', 'text') +
          f('d-rmem', '内存 request', '128Mi', 'text') + f('d-lmem', '内存 limit', '512Mi', 'text') + '</div>' +
          '<div class="chk-grid mt8">' +
          '<label class="chk"><input type="checkbox" id="d-probe" checked>加上存活/就绪探针</label>' +
          '<label class="chk"><input type="checkbox" id="d-security">加上安全上下文（非 root）</label>' +
          '<label class="chk"><input type="checkbox" id="d-svc" checked>同时生成 Service</label></div></div>';
      }
      function svcForm() {
        return '<div class="t-section"><div class="sec-t">Service</div><div class="row tight">' +
          f('s-name', '服务名', 'nginx-demo', 'text') + f('s-ns', '命名空间', 'default', 'text') +
          f('s-type', '类型', 'ClusterIP', 'text') + f('s-port', 'port', '80', 'number') +
          f('s-target', 'targetPort', '80', 'number') + f('s-node', 'nodePort（NodePort 时）', '30080', 'number') + '</div>' +
          '<div class="field mt8"><label class="field-l">选择器（每行 KEY=VALUE）</label>' +
          '<textarea id="s-sel" style="min-height:60px">app=nginx-demo</textarea></div></div>';
      }
      function ingForm() {
        return '<div class="t-section"><div class="sec-t">Ingress</div><div class="row tight">' +
          f('i-name', '名称', 'nginx-demo', 'text') + f('i-ns', '命名空间', 'default', 'text') +
          f('i-host', '域名', 'demo.example.com', 'text') + f('i-path', '路径', '/', 'text') +
          f('i-svc', '后端服务名', 'nginx-demo', 'text') + f('i-port', '服务端口', '80', 'number') +
          f('i-class', 'ingressClass', 'nginx', 'text') + f('i-tls', 'TLS Secret（留空不启用）', '', 'text') + '</div>' +
          '<div class="hint small">路径类型默认 Prefix；启用 TLS 时会生成 tls 段并自动创建证书 Secret 引用</div></div>';
      }
      function cmForm() {
        return '<div class="t-section"><div class="sec-t">ConfigMap</div><div class="row tight">' +
          f('c-name', '名称', 'app-config', 'text') + f('c-ns', '命名空间', 'default', 'text') + '</div>' +
          '<div class="field mt8"><label class="field-l">键值（每行 KEY=VALUE）</label>' +
          '<textarea id="c-kv" style="min-height:120px">TZ=Asia/Shanghai\nAPP_ENV=production\nLOG_LEVEL=info\nMAX_CONNECTIONS=200</textarea></div></div>';
      }
      function pvcForm() {
        return '<div class="t-section"><div class="sec-t">PersistentVolumeClaim</div><div class="row tight">' +
          f('p-name', '名称', 'data-pvc', 'text') + f('p-ns', '命名空间', 'default', 'text') +
          f('p-size', '容量', '20Gi', 'text') + f('p-sc', 'storageClass', 'nfs-client', 'text') +
          f('p-mode', '访问模式', 'ReadWriteMany', 'text') + '</div>' +
          '<div class="hint small">常用访问模式：ReadWriteOnce（单节点读写）、ReadOnlyMany（多节点只读）、ReadWriteMany（多节点读写，需 NFS/Ceph 等支持）</div></div>';
      }
      function cronForm() {
        return '<div class="t-section"><div class="sec-t">CronJob</div><div class="row tight">' +
          f('j-name', '名称', 'db-backup', 'text') + f('j-ns', '命名空间', 'default', 'text') +
          f('j-sched', '调度（cron）', '0 2 * * *', 'text') + f('j-img', '镜像', 'mysql:8.0', 'text') +
          f('j-cmd', '命令（空格分隔）', 'sh -c "mysqldump -h db -uroot -p$MYSQL_PWD appdb > /backup/app.sql"', 'text') + '</div>' +
          '<div class="row tight mt8">' + f('j-back', '保留历史成功数', '3', 'number') +
          f('j-fail', '失败重试次数', '3', 'number') + f('j-deadline', '超时秒数', '3600', 'number') + '</div>' +
          '<div class="hint small">注意：K8s CronJob 的时区默认 UTC，如需北京时间可用 <span class="mono">timeZone: "Asia/Shanghai"</span>（1.27+ 稳定）</div></div>';
      }
      function f(id, label, val, type) {
        return '<div class="field"><label class="field-l">' + label + '</label>' +
          '<input type="' + (type || 'text') + '" id="' + id + '" value="' + U.esc(val) + '"></div>';
      }
    },
    init: function (root) {
      var $ = function (s) { return root.querySelector(s); };
      var cur = 'deploy';
      U.$$('#ktab .tab', root).forEach(function (t) {
        t.onclick = function () {
          U.$$('#ktab .tab', root).forEach(function (x) { x.classList.remove('on'); });
          t.classList.add('on'); cur = t.dataset.m;
          U.$$('.pane-k', root).forEach(function (p) { p.hidden = p.id !== 'k-' + cur; });
          gen();
        };
      });
      var kv = function (txt) {
        return txt.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
      };
      var gen = function () {
        var y = '';
        if (cur === 'deploy') y = genDeploy();
        else if (cur === 'svc') y = genSvc();
        else if (cur === 'ing') y = genIng();
        else if (cur === 'cm') y = genCm();
        else if (cur === 'pvc') y = genPvc();
        else y = genCron();
        U.setOut('k8sout', y);
        return y;
      };
      function genDeploy() {
        var n = $('#d-name').value.trim() || 'app', ns = $('#d-ns').value.trim() || 'default';
        var rep = $('#d-rep').value || '1', img = $('#d-img').value.trim() || 'nginx';
        var port = $('#d-port').value || '80';
        var L = ['apiVersion: apps/v1', 'kind: Deployment', 'metadata:', '  name: ' + n, '  namespace: ' + ns,
          '  labels:', '    app: ' + n, 'spec:', '  replicas: ' + rep,
          '  selector:', '    matchLabels:', '      app: ' + n,
          '  template:', '    metadata:', '      labels:', '        app: ' + n,
          '    spec:', '      containers:', '      - name: ' + n,
          '        image: ' + img, '        imagePullPolicy: ' + ($('#d-policy').value || 'IfNotPresent'),
          '        ports:', '        - name: http', '          containerPort: ' + port];
        var envs = kv($('#d-env').value);
        if (envs.length) {
          L.push('        env:');
          envs.forEach(function (e) {
            var i = e.indexOf('=');
            if (i < 0) return;
            L.push('        - name: ' + e.slice(0, i).trim(), '          value: "' + e.slice(i + 1).trim() + '"');
          });
        }
        L.push('        resources:', '          requests:',
          '            cpu: "' + $('#d-rcpu').value + '"', '            memory: "' + $('#d-rmem').value + '"',
          '          limits:', '            cpu: "' + $('#d-lcpu').value + '"', '            memory: "' + $('#d-lmem').value + '"');
        if ($('#d-probe').checked) {
          L.push('        livenessProbe:', '          httpGet:', '            path: /', '            port: ' + port,
            '          initialDelaySeconds: 30', '          periodSeconds: 10',
            '        readinessProbe:', '          httpGet:', '            path: /', '            port: ' + port,
            '          initialDelaySeconds: 5', '          periodSeconds: 5');
        }
        if ($('#d-security').checked) {
          L.push('        securityContext:', '          runAsNonRoot: true', '          runAsUser: 1000',
            '          allowPrivilegeEscalation: false', '          readOnlyRootFilesystem: false');
        }
        var out = L.join('\n');
        if ($('#d-svc').checked) out += '\n---\n' + genSvc(n, ns, port);
        return out;
      }
      function genSvc(n, ns, port) {
        var fromDeploy = !!n;           // 由 Deployment 面板联合生成
        n = n || $('#s-name').value.trim() || 'app';
        ns = ns || $('#s-ns').value.trim() || 'default';
        var type = $('#s-type').value || 'ClusterIP';
        var p = port || $('#s-port').value || '80', t = port || $('#s-target').value || '80';
        var L = ['apiVersion: v1', 'kind: Service', 'metadata:', '  name: ' + n, '  namespace: ' + ns,
          'spec:', '  type: ' + type, '  selector:'];
        var sel = fromDeploy ? ['app=' + n] : ($('#s-sel') ? kv($('#s-sel').value) : []);
        if (!sel.length) sel = ['app=' + n];
        sel.forEach(function (s) {
          var i = s.indexOf('=');
          if (i > 0) L.push('    ' + s.slice(0, i).trim() + ': ' + s.slice(i + 1).trim());
        });
        L.push('  ports:', '  - name: http', '    port: ' + p, '    targetPort: ' + t, '    protocol: TCP');
        if (type === 'NodePort') L.push('    nodePort: ' + ($('#s-node').value || '30080'));
        return L.join('\n');
      }
      function genIng() {
        var n = $('#i-name').value.trim() || 'ing', ns = $('#i-ns').value.trim() || 'default';
        var L = ['apiVersion: networking.k8s.io/v1', 'kind: Ingress', 'metadata:', '  name: ' + n, '  namespace: ' + ns,
          '  annotations:', '    nginx.ingress.kubernetes.io/rewrite-target: /'];
        var tls = $('#i-tls').value.trim();
        L.push('spec:', '  ingressClassName: ' + ($('#i-class').value || 'nginx'));
        if (tls) L.push('  tls:', '  - hosts:', '    - ' + $('#i-host').value.trim(), '    secretName: ' + tls);
        L.push('  rules:', '  - host: ' + $('#i-host').value.trim(), '    http:', '      paths:',
          '      - path: ' + $('#i-path').value.trim(), '        pathType: Prefix',
          '        backend:', '          service:', '            name: ' + $('#i-svc').value.trim(),
          '            port:', '              number: ' + ($('#i-port').value || '80'));
        return L.join('\n');
      }
      function genCm() {
        var n = $('#c-name').value.trim() || 'cm', ns = $('#c-ns').value.trim() || 'default';
        var L = ['apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: ' + n, '  namespace: ' + ns, 'data:'];
        kv($('#c-kv').value).forEach(function (e) {
          var i = e.indexOf('=');
          if (i < 0) return;
          L.push('  ' + e.slice(0, i).trim() + ': "' + e.slice(i + 1).trim() + '"');
        });
        return L.join('\n');
      }
      function genPvc() {
        var n = $('#p-name').value.trim() || 'pvc', ns = $('#p-ns').value.trim() || 'default';
        return ['apiVersion: v1', 'kind: PersistentVolumeClaim', 'metadata:', '  name: ' + n, '  namespace: ' + ns,
          'spec:', '  accessModes:', '  - ' + ($('#p-mode').value || 'ReadWriteOnce'),
          '  resources:', '    requests:', '      storage: ' + ($('#p-size').value || '10Gi'),
          '  storageClassName: ' + ($('#p-sc').value || '')].join('\n');
      }
      function genCron() {
        var n = $('#j-name').value.trim() || 'cron', ns = $('#j-ns').value.trim() || 'default';
        var cmd = $('#j-cmd').value.trim().split(/\s+/);
        return ['apiVersion: batch/v1', 'kind: CronJob', 'metadata:', '  name: ' + n, '  namespace: ' + ns,
          'spec:', '  schedule: "' + ($('#j-sched').value || '0 2 * * *') + '"',
          '  timeZone: "Asia/Shanghai"',
          '  successfulJobsHistoryLimit: ' + ($('#j-back').value || 3),
          '  failedJobsHistoryLimit: ' + ($('#j-fail').value || 3),
          '  concurrencyPolicy: Forbid',
          '  jobTemplate:', '    spec:',
          '      backoffLimit: ' + ($('#j-fail').value || 3),
          '      activeDeadlineSeconds: ' + ($('#j-deadline').value || 3600),
          '      template:', '        spec:', '          restartPolicy: OnFailure',
          '          containers:', '          - name: ' + n, '            image: ' + $('#j-img').value.trim(),
          '            command: [' + cmd.map(function (c) { return '"' + c.replace(/"/g, '\\"') + '"'; }).join(', ') + ']'].join('\n');
      }
      $('#k8sgo').onclick = gen;
      U.$$('.pane-k input, .pane-k textarea', root).forEach(function (e) {
        e.addEventListener('change', function () { if (cur === 'deploy' || cur === 'svc') gen(); });
      });
      $('#k8sdl').onclick = function () {
        var name = (cur === 'deploy' ? $('#d-name') : cur === 'svc' ? $('#s-name') : cur === 'ing' ? $('#i-name') :
          cur === 'cm' ? $('#c-name') : cur === 'pvc' ? $('#p-name') : $('#j-name')).value.trim() || 'manifest';
        U.download(name + '.yaml', document.getElementById('k8sout').textContent);
      };
      $('#k8sapply').onclick = function () {
        var ns = (cur === 'deploy' ? $('#d-ns') : cur === 'svc' ? $('#s-ns') : cur === 'ing' ? $('#i-ns') :
          cur === 'cm' ? $('#c-ns') : cur === 'pvc' ? $('#p-ns') : $('#j-ns')).value.trim();
        U.copy('kubectl apply -f manifest.yaml -n ' + ns + '\n# 查看状态\nkubectl get pods -n ' + ns + ' -w\n# 排障\nkubectl describe pod -n ' + ns + ' -l app=' +
          (cur === 'deploy' ? $('#d-name').value.trim() : 'app'));
      };
      gen();
    }
  });

  /* ---------- 2. kubectl 速查 ---------- */
  LB.register({
    id: 'kubectl', cat: 'cloud', icon: '🎛️', name: 'kubectl 命令速查',
    desc: '按场景检索 kubectl 命令，支持复制',
    kw: 'kubectl k8s 命令 速查 kubernetes 排障 get logs exec',
    tpl: function () {
      var groups = [];
      D.kubectl.forEach(function (c) { if (groups.indexOf(c[0]) < 0) groups.push(c[0]); });
      return '<div class="t-section"><div class="sec-t">搜索</div>' +
        '<input type="text" id="kf" placeholder="如 日志 / 回滚 / 节点 / exec">' +
        '<div class="tabs mt12" id="ktabs"><button class="tab on" data-g="all">全部</button>' +
        groups.map(function (g) { return '<button class="tab" data-g="' + g + '">' + g + '</button>'; }).join('') + '</div></div>' +
        '<div class="t-section"><div class="sec-t">命令</div><div id="klist"></div></div>';
    },
    init: function (root) {
      var $ = function (s) { return root.querySelector(s); };
      var cur = 'all';
      var render = function () {
        var k = $('#kf').value.trim().toLowerCase();
        var rows = D.kubectl.filter(function (c) {
          return (cur === 'all' || c[0] === cur) && (!k || c[1].toLowerCase().indexOf(k) >= 0 || c[2].toLowerCase().indexOf(k) >= 0);
        });
        $('#klist').innerHTML = rows.length ? rows.map(function (c) {
          return '<div class="cheat-item"><div style="flex:0 0 62px"><span class="tag info">' + U.esc(c[0]) + '</span></div>' +
            '<div class="cmd">' + U.esc(c[1]) + '</div><div class="dsc">' + U.esc(c[2]) + '</div>' +
            '<button class="btn btn-sm cp" data-c="' + U.esc(c[1]) + '">复制</button></div>';
        }).join('') : '<div class="small" style="text-align:center;padding:20px">无匹配命令</div>';
        U.$$('#klist .cp', root).forEach(function (b) { b.onclick = function () { U.copy(b.dataset.c); }; });
      };
      U.$$('#ktabs .tab', root).forEach(function (t) {
        t.onclick = function () {
          U.$$('#ktabs .tab', root).forEach(function (x) { x.classList.remove('on'); });
          t.classList.add('on'); cur = t.dataset.g; render();
        };
      });
      $('#kf').oninput = render;
      render();
    }
  });

  /* ---------- 3. docker run ↔ compose ---------- */
  LB.register({
    id: 'dockerconv', cat: 'cloud', icon: '🐳', name: 'docker run ↔ compose 互转',
    desc: '把 run 命令转成 compose，或反过来',
    kw: 'docker run compose 转换 yaml 互转 docker-compose',
    tpl: function () {
      return '<div class="tabs" id="dtab"><button class="tab on" data-m="r2c">run → compose</button>' +
        '<button class="tab" data-m="c2r">compose → run</button></div>' +
        '<div id="d-r2c"><div class="t-section"><div class="sec-t">粘贴 docker run 命令</div>' +
        '<textarea id="drun" style="min-height:120px">docker run -d --name web --restart=always -p 8080:80 -p 8443:443 -v /data/nginx/conf:/etc/nginx/conf.d -v /data/nginx/logs:/var/log/nginx -e TZ=Asia/Shanghai -e NGINX_HOST=example.com --network mynet --memory 512m --cpus 0.5 nginx:1.25-alpine</textarea>' +
        '<div class="field mt8"><label class="field-l">服务名（默认取 --name）</label><input type="text" id="dsvc" value="web"></div>' +
        '<div class="btn-group"><button class="btn btn-pri" id="dgo">转换</button></div></div>' +
        '<div class="t-section"><div class="sec-t">docker-compose.yml</div>' + U.outBlock('dout') + '</div></div>' +
        '<div id="d-c2r" hidden><div class="t-section"><div class="sec-t">粘贴 docker-compose.yml</div>' +
        '<textarea id="dcom" style="min-height:220px">services:\n  web:\n    image: nginx:1.25-alpine\n    container_name: web\n    restart: always\n    ports:\n      - "8080:80"\n      - "8443:443"\n    volumes:\n      - /data/nginx/conf:/etc/nginx/conf.d\n      - /data/nginx/logs:/var/log/nginx\n    environment:\n      - TZ=Asia/Shanghai\n      - NGINX_HOST=example.com\n    networks:\n      - mynet\nnetworks:\n  mynet:\n    external: true</textarea>' +
        '<div class="btn-group"><button class="btn btn-pri" id="dgo2">转换</button></div></div>' +
        '<div class="t-section"><div class="sec-t">docker run 命令</div>' + U.outBlock('dout2') + '</div></div>' +
        '<div class="t-section"><div class="sec-t">对照说明</div><div class="small" style="line-height:2">' +
        '• <span class="mono">-v</span> 卷映射、<span class="mono">-p</span> 端口、<span class="mono">-e</span> 环境变量三者可直接对应；<br>' +
        '• <span class="mono">--link</span> 已废弃，compose 中用 <span class="mono">depends_on</span> + 服务名互访；<br>' +
        '• <span class="mono">--memory / --cpus</span> 在 compose v3 里需写到 <span class="mono">deploy.resources</span>（Swarm 生效），非 Swarm 环境建议用 <span class="mono">mem_limit</span>；<br>' +
        '• 改了 <span class="mono">.env</span> 或 <span class="mono">environment</span> 后，<b>必须用 <span class="mono">docker compose up -d --force-recreate</span></b>，<span class="mono">restart</span> 不会重新注入环境变量。</div></div>';
    },
    init: function (root) {
      var $ = function (s) { return root.querySelector(s); };
      U.$$('#dtab .tab', root).forEach(function (t) {
        t.onclick = function () {
          U.$$('#dtab .tab', root).forEach(function (x) { x.classList.remove('on'); });
          t.classList.add('on');
          var m = t.dataset.m;
          $('#d-r2c').hidden = m !== 'r2c'; $('#d-c2r').hidden = m !== 'c2r';
        };
      });
      function tokenize(cmd) {
        var toks = [], cur2 = '', q = null;
        for (var i = 0; i < cmd.length; i++) {
          var c = cmd[i];
          if (q) { if (c === q) q = null; else cur2 += c; continue; }
          if (c === '"' || c === "'") { q = c; continue; }
          if (/\s/.test(c)) { if (cur2) { toks.push(cur2); cur2 = ''; } continue; }
          cur2 += c;
        }
        if (cur2) toks.push(cur2);
        return toks;
      }
      $('#dgo').onclick = function () {
        var toks = tokenize($('#drun').value.replace(/\\\s*\n/g, ' ').trim());
        if (toks[0] === 'docker' && toks[1] === 'run') toks = toks.slice(2);
        var svc = { image: '', name: '', ports: [], volumes: [], env: [], envFile: [], networks: [], labels: [], links: [] };
        var extra = { restart: '', mem: '', cpus: '', user: '', workdir: '', entrypoint: '', privileged: false, netHost: false, pid: '' };
        for (var i = 0; i < toks.length; i++) {
          var t = toks[i];
          if (t[0] !== '-') { if (!svc.image) svc.image = t; else svc.cmd = (svc.cmd || []).concat([t]); continue; }
          var val = function () { return toks[++i]; };
          if (t === '-d' || t === '--detach' || t === '-it' || t === '-i' || t === '-t') continue;
          else if (t === '--name') svc.name = val();
          else if (t === '-p' || t === '--publish') svc.ports.push(val());
          else if (t === '-v' || t === '--volume') svc.volumes.push(val());
          else if (t === '-e' || t === '--env') svc.env.push(val());
          else if (t === '--env-file') svc.envFile.push(val());
          else if (t === '--network' || t === '--net') { var n = val(); if (n === 'host') extra.netHost = true; else svc.networks.push(n); }
          else if (t === '--restart') extra.restart = val();
          else if (t === '--memory' || t === '-m') extra.mem = val();
          else if (t === '--cpus') extra.cpus = val();
          else if (t === '--user' || t === '-u') extra.user = val();
          else if (t === '-w' || t === '--workdir') extra.workdir = val();
          else if (t === '--entrypoint') extra.entrypoint = val();
          else if (t === '-l' || t === '--label') svc.labels.push(val());
          else if (t === '--link') svc.links.push(val());
          else if (t === '--privileged') extra.privileged = true;
          else if (t === '--pid') extra.pid = val();
          else if (t.indexOf('-') === 0 && t.length > 1) { /* 未知 flag，跳过取值判断 */ }
        }
        if (!svc.image) { U.toast('未找到镜像名', 'err'); return; }
        var name = $('#dsvc').value.trim() || svc.name || 'app';
        var L = ['services:', '  ' + name + ':', '    image: ' + svc.image];
        if (svc.name) L.push('    container_name: ' + svc.name);
        if (extra.restart) L.push('    restart: ' + (extra.restart === 'unless-stopped' ? 'unless-stopped' : extra.restart));
        if (svc.ports.length) { L.push('    ports:'); svc.ports.forEach(function (p) { L.push('      - "' + p + '"'); }); }
        if (svc.volumes.length) { L.push('    volumes:'); svc.volumes.forEach(function (v) { L.push('      - "' + v + '"'); }); }
        if (svc.env.length) { L.push('    environment:'); svc.env.forEach(function (e) { L.push('      - "' + e.replace(/"/g, '\\"') + '"'); }); }
        if (svc.envFile.length) { L.push('    env_file:'); svc.envFile.forEach(function (e) { L.push('      - ' + e); }); }
        if (extra.netHost) L.push('    network_mode: host');
        else if (svc.networks.length) {
          L.push('    networks:'); svc.networks.forEach(function (n) { L.push('      - ' + n); });
        }
        if (extra.mem || extra.cpus) {
          L.push('    deploy:', '      resources:', '        limits:');
          if (extra.cpus) L.push('          cpus: "' + extra.cpus + '"');
          if (extra.mem) L.push('          memory: ' + extra.mem);
          L.push('    # 非 Swarm 环境如需限制，改用下面两行（compose v2 支持）');
          if (extra.mem) L.push('    mem_limit: ' + extra.mem);
          if (extra.cpus) L.push('    cpus: ' + extra.cpus);
        }
        if (extra.user) L.push('    user: "' + extra.user + '"');
        if (extra.workdir) L.push('    working_dir: ' + extra.workdir);
        if (extra.entrypoint) L.push('    entrypoint: ' + extra.entrypoint);
        if (svc.labels.length) { L.push('    labels:'); svc.labels.forEach(function (x) { L.push('      - "' + x + '"'); }); }
        if (extra.privileged) L.push('    privileged: true');
        if (extra.pid) L.push('    pid: "' + extra.pid + '"');
        if (svc.cmd && svc.cmd.length) L.push('    command: ' + svc.cmd.join(' '));
        if (svc.links.length) L.push('    # ⚠️ 原命令使用 --link（已废弃），建议改为 depends_on:\n    # depends_on:\n    #   - ' + svc.links.join('\n    #   - '));
        if (svc.networks.length) {
          L.push('', 'networks:');
          svc.networks.forEach(function (n) { L.push('  ' + n + ':', '    external: true'); });
        }
        L.push('', '# 启动：docker compose up -d --force-recreate');
        U.setOut('dout', L.join('\n'));
      };
      $('#dgo2').onclick = function () {
        var lines = $('#dcom').value.split('\n');
        var inSvc = false, svcs = {}, curName = null, topNetworks = [];
        for (var i = 0; i < lines.length; i++) {
          var raw = lines[i].replace(/\s+$/, '');
          if (!raw.trim() || /^\s*#/.test(raw)) continue;
          var indent = raw.length - raw.replace(/^\s+/, '').length;
          var t = raw.trim();
          if (indent === 0) {
            if (/^services\s*:/.test(t)) { inSvc = true; continue; }
            inSvc = false;
            if (/^networks\s*:/.test(t)) {
              for (var j = i + 1; j < lines.length; j++) {
                var l2 = lines[j], ind2 = l2.length - l2.replace(/^\s+/, '').length;
                if (!l2.trim()) continue;
                if (ind2 <= 0) break;
                if (ind2 <= 2 && l2.trim().indexOf('-') !== 0) topNetworks.push(l2.trim().replace(/:$/, ''));
              }
            }
            continue;
          }
          if (!inSvc) continue;
          if (indent <= 2 && /:$/.test(t)) { curName = t.replace(/:$/, ''); svcs[curName] = { lists: {} }; continue; }
          if (!curName) continue;
          var m = /^(-?\s*)([^:]+):\s*(.*)$/.exec(t);
          if (t.indexOf('- ') === 0 || t === '-') {
            // 列表项归属上一个 key
            if (svcs[curName]._last) svcs[curName].lists[svcs[curName]._last].push(t.replace(/^-\s*/, '').replace(/^["']|["']$/g, ''));
            continue;
          }
          if (m) {
            var k = m[2].trim(), v = m[3].trim();
            if (v === '') { svcs[curName].lists[k] = []; svcs[curName]._last = k; }
            else { svcs[curName][k] = v.replace(/^["']|["']$/g, ''); svcs[curName]._last = null; }
          }
        }
        var names = Object.keys(svcs);
        if (!names.length) { U.toast('未解析到 services，请检查 YAML 缩进', 'err'); return; }
        var out = [];
        names.forEach(function (n) {
          var s = svcs[n], cmd = ['docker run -d'];
          if (s.container_name) cmd.push('--name ' + s.container_name);
          else cmd.push('--name ' + n);
          if (s.restart) cmd.push('--restart ' + s.restart);
          (s.lists.ports || []).forEach(function (p) { cmd.push('-p ' + p); });
          (s.lists.volumes || []).forEach(function (v) { cmd.push('-v "' + v + '"'); });
          (s.lists.environment || []).forEach(function (e) { cmd.push('-e "' + e + '"'); });
          (s.env_file || []).forEach(function (e) { cmd.push('--env-file ' + e); });
          (s.lists.networks || []).forEach(function (x) { cmd.push('--network ' + x); });
          if (s.network_mode) cmd.push('--network ' + s.network_mode);
          if (s.mem_limit) cmd.push('--memory ' + s.mem_limit);
          if (s.cpus) cmd.push('--cpus ' + s.cpus);
          if (s.user) cmd.push('-u ' + s.user);
          if (s.working_dir) cmd.push('-w ' + s.working_dir);
          if (s.privileged === 'true') cmd.push('--privileged');
          cmd.push(s.image || '(未指定镜像)');
          if (s.command) cmd.push(s.command);
          out.push('# ' + n + '\n' + cmd.join(' ') + '\n');
        });
        if (topNetworks.length) {
          out.push('# 需要先创建网络：');
          topNetworks.forEach(function (n) { out.push('docker network create ' + n); });
        }
        U.setOut('dout2', out.join('\n'));
      };
      $('#dgo').click(); $('#dgo2').click();
    }
  });

  /* ---------- 4. Docker 速查 + Dockerfile 模板 ---------- */
  LB.register({
    id: 'dockercheat', cat: 'cloud', icon: '📦', name: 'Docker 速查 / Dockerfile',
    desc: '常用 docker 命令与多阶段构建模板',
    kw: 'docker 命令 速查 dockerfile 模板 构建 镜像 清理',
    tpl: function () {
      var groups = [];
      D.dockerCmd.forEach(function (c) { if (groups.indexOf(c[0]) < 0) groups.push(c[0]); });
      return '<div class="tabs" id="dct"><button class="tab on" data-m="cmd">命令速查</button>' +
        '<button class="tab" data-m="df">Dockerfile 模板</button></div>' +
        '<div id="dc-cmd"><div class="t-section"><div class="sec-t">搜索</div>' +
        '<input type="text" id="dcf" placeholder="如 日志 / 镜像 / 清理 / exec">' +
        '<div class="tabs mt12" id="dcg"><button class="tab on" data-g="all">全部</button>' +
        groups.map(function (g) { return '<button class="tab" data-g="' + g + '">' + g + '</button>'; }).join('') + '</div></div>' +
        '<div class="t-section"><div class="sec-t">命令</div><div id="dcl"></div></div></div>' +
        '<div id="dc-df" hidden><div class="t-section"><div class="sec-t">选择模板</div>' +
        '<div class="tabs" id="dft">' + Object.keys(D.dockerfiles).map(function (k, i) {
          return '<button class="tab' + (i === 0 ? ' on' : '') + '" data-k="' + k + '">' + k.toUpperCase() + '</button>';
        }).join('') + '</div>' + U.outBlock('dfout') +
        '<div class="btn-group"><button class="btn btn-sm" id="dfdl">下载 Dockerfile</button></div></div>' +
        '<div class="t-section"><div class="sec-t">.dockerignore 建议</div><div class="out">' +
        U.esc(['node_modules', '.git', '.gitignore', '*.log', 'dist', 'build', '.env', '.DS_Store', '*.md', '__pycache__', 'venv', '.idea', '.vscode'].join('\n')) +
        '</div></div>' +
        '<div class="t-section"><div class="sec-t">减小镜像体积的常用手段</div><div class="small" style="line-height:2">' +
        '• 用 <span class="mono">alpine</span> / <span class="mono">slim</span> 基础镜像；<br>' +
        '• 多阶段构建，只把产物复制到运行阶段；<br>' +
        '• 把不常变的层（依赖安装）放在前面，利用构建缓存；<br>' +
        '• 同层内清理缓存：<span class="mono">apt-get clean && rm -rf /var/lib/apt/lists/*</span>；<br>' +
        '• 合并 RUN 指令减少层数；<br>' +
        '• Go 用 <span class="mono">CGO_ENABLED=0</span> 静态编译，甚至可 <span class="mono">FROM scratch</span></div></div></div>';
    },
    init: function (root) {
      var $ = function (s) { return root.querySelector(s); };
      U.$$('#dct .tab', root).forEach(function (t) {
        t.onclick = function () {
          U.$$('#dct .tab', root).forEach(function (x) { x.classList.remove('on'); });
          t.classList.add('on');
          var m = t.dataset.m;
          $('#dc-cmd').hidden = m !== 'cmd'; $('#dc-df').hidden = m !== 'df';
        };
      });
      var cur = 'all';
      var render = function () {
        var k = $('#dcf').value.trim().toLowerCase();
        var rows = D.dockerCmd.filter(function (c) {
          return (cur === 'all' || c[0] === cur) && (!k || c[1].toLowerCase().indexOf(k) >= 0 || c[2].toLowerCase().indexOf(k) >= 0);
        });
        $('#dcl').innerHTML = rows.length ? rows.map(function (c) {
          return '<div class="cheat-item"><div class="cmd">' + U.esc(c[1]) + '</div><div class="dsc">' + U.esc(c[2]) + '</div>' +
            '<button class="btn btn-sm cp" data-c="' + U.esc(c[1]) + '">复制</button></div>';
        }).join('') : '<div class="small" style="text-align:center;padding:20px">无匹配命令</div>';
        U.$$('#dcl .cp', root).forEach(function (b) { b.onclick = function () { U.copy(b.dataset.c); }; });
      };
      U.$$('#dcg .tab', root).forEach(function (t) {
        t.onclick = function () {
          U.$$('#dcg .tab', root).forEach(function (x) { x.classList.remove('on'); });
          t.classList.add('on'); cur = t.dataset.g; render();
        };
      });
      $('#dcf').oninput = render;
      render();
      U.$$('#dft .tab', root).forEach(function (t) {
        t.onclick = function () {
          U.$$('#dft .tab', root).forEach(function (x) { x.classList.remove('on'); });
          t.classList.add('on');
          U.setOut('dfout', D.dockerfiles[t.dataset.k]);
        };
      });
      U.setOut('dfout', D.dockerfiles.node);
      $('#dfdl').onclick = function () {
        var k = (root.querySelector('#dft .tab.on') || {}).dataset ? root.querySelector('#dft .tab.on').dataset.k : 'node';
        U.download('Dockerfile.' + k, document.getElementById('dfout').textContent);
      };
    }
  });
})();
