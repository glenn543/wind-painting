// 風吹水面倒影原型（WebGL2，免建置 classic script）
// 每幀流程：
//   1. gust  ：陣風能量場 E（低解析度 ping-pong）— 沿風向平流、擴散、渦流、衰減；點擊時注入
//   2. height：水面高度（半解析度）— 常駐風的方向性細波 + 陣風區的碎波，G 通道帶上 E
//   3. comp  ：依水面梯度偏移讀圖（倒影扭曲）+ 荷花擺動 + 陣風推移 + 閃光，再與上一幀混合（殘影）
//   4. present：輸出到畫面，加紙紋顆粒與暗角
(function () {
  'use strict';

  var PARAMS = [
    { head: '常駐風' },
    { key: 'wind', label: '風力', min: 0, max: 1, step: 0.01 },
    { key: 'gustVar', label: '忽強忽弱', min: 0, max: 1.5, step: 0.01 },
    { key: 'gustPace', label: '變化快慢', min: 0.05, max: 3, step: 0.01 },
    { key: 'patchSize', label: '風斑大小', min: 0.1, max: 1.5, step: 0.01 },
    { key: 'flow', label: '平時流動速度', min: 0, max: 2, step: 0.01 },
    { head: '自動陣風' },
    { key: 'autoRate', label: '頻率（次/分）', min: 0, max: 30, step: 0.5 },
    { key: 'autoGust', label: '強度', min: 0, max: 3, step: 0.01 },
    { key: 'autoSize', label: '範圍', min: 0.05, max: 0.8, step: 0.01 },
    { head: '點擊陣風' },
    { key: 'gust', label: '強度', min: 0, max: 3, step: 0.01 },
    { key: 'gustSize', label: '範圍', min: 0.05, max: 0.6, step: 0.01 },
    { key: 'swirl', label: '旋轉（含自動）', min: 0, max: 2, step: 0.01 },
    { head: '畫面' },
    { key: 'echo', label: '殘影量', min: 0, max: 0.98, step: 0.01 },
    { key: 'fade', label: '殘影消散速度', min: 0, max: 1, step: 0.01 },
    { key: 'dragLen', label: '拖曳長度', min: 0, max: 4, step: 0.05 },
    { key: 'echoBlur', label: '殘影模糊', min: 0, max: 8, step: 0.05 },
    { key: 'distort', label: '倒影扭曲', min: 0, max: 3, step: 0.01 },
    { key: 'chaos', label: '最大擾動', min: 0, max: 2, step: 0.01 },
    { key: 'chaosAt', label: '擾動門檻', min: 0.1, max: 1.2, step: 0.01 },
    { key: 'soften', label: '陣風邊緣柔和', min: 0, max: 1, step: 0.01 },
    { key: 'sway', label: '荷花擺動', min: 0, max: 3, step: 0.01 },
    { key: 'glint', label: '水面閃光', min: 0, max: 2, step: 0.01 },
    { head: '節奏風（音樂強弱，scene.rhythm）' },
    { key: 'rhythmAmt', label: '節奏風力', min: 0, max: 1, step: 0.01 },
    { key: 'rhythmAttack', label: '起風時間（秒）', min: 0.1, max: 5, step: 0.05 },
    { key: 'rhythmRelease', label: '退風時間（秒）', min: 0.2, max: 10, step: 0.1 },
    { head: '音量扭曲（AE 曲線，scene.distortCurve）' },
    { key: 'audioDistort', label: '音量扭曲量', min: 0, max: 4, step: 0.05 },
    { key: 'audioRelease', label: '扭曲退去時間（秒）', min: 0, max: 2, step: 0.05 },
    { head: '每拍擾動（scene.beat）' },
    { key: 'beatAmt', label: '節拍擾動', min: 0, max: 1.5, step: 0.01 },
    { key: 'beatDecay', label: '每拍退去快慢', min: 1, max: 12, step: 0.1 },
    { key: 'beatAccent', label: '小節重拍加強', min: 0, max: 2, step: 0.01 },
  ];
  var MAX_GUSTS = 8;
  var GUST_LIFE = 1.0; // 秒：注入期；之後能量靠平流與衰減自然散去

  var scenes = window.WIND_SCENES || [];
  var sceneId = new URLSearchParams(location.search).get('scene');
  var scene = scenes.filter(function (s) { return s.id === sceneId; })[0] || scenes[0];
  var P = Object.assign({}, scene.params);

  var canvas = document.getElementById('view');
  var gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false });
  if (!gl) { fail('這個瀏覽器不支援 WebGL2。'); return; }
  var floatOK = !!gl.getExtension('EXT_color_buffer_float');

  // ---------- shaders ----------
  var VERT = '#version 300 es\nin vec2 a;out vec2 vUv;void main(){vUv=a*0.5+0.5;gl_Position=vec4(a,0.,1.);}';

  var COMMON = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 vUv; out vec4 o;',
    'vec2 hash2(vec2 p){p=vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3)));return -1.0+2.0*fract(sin(p)*43758.5453);}',
    'float gnoise(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.0-2.0*f);',
    ' return mix(mix(dot(hash2(i),f),dot(hash2(i+vec2(1,0)),f-vec2(1,0)),u.x),',
    '            mix(dot(hash2(i+vec2(0,1)),f-vec2(0,1)),dot(hash2(i+vec2(1,1)),f-vec2(1,1)),u.x),u.y);}',
    'float hash1(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}',
  ].join('\n');

  var GUST_FS = COMMON + `
uniform sampler2D uPrev; uniform vec2 uTexel; uniform float uDt, uTime, uAspect, uWind, uSwirl;
uniform vec2 uWindDir; uniform vec4 uGusts[${MAX_GUSTS}]; uniform float uGustR[${MAX_GUSTS}]; uniform int uGustCount;
void main(){
  vec2 p = vec2(vUv.x*uAspect, vUv.y);
  // 渦流：低頻雜訊的 curl，讓陣風邊走邊捲（uSwirl = 0 時直直順風走）
  float e = 0.02; vec2 q = p*2.0 + vec2(0.0, uTime*0.07);
  vec2 curl = vec2(gnoise(q+vec2(0,e))-gnoise(q-vec2(0,e)), -(gnoise(q+vec2(e,0))-gnoise(q-vec2(e,0))))/(2.0*e);
  vec2 vel = uWindDir*(0.07+0.16*uWind) + curl*0.035*uSwirl;
  vec2 src = vUv - vec2(vel.x/uAspect, vel.y)*uDt;
  float E = texture(uPrev, src).r;
  float s = texture(uPrev, src+vec2(uTexel.x,0)).r + texture(uPrev, src-vec2(uTexel.x,0)).r
          + texture(uPrev, src+vec2(0,uTexel.y)).r + texture(uPrev, src-vec2(0,uTexel.y)).r;
  E = mix(E, s*0.25, 0.3);
  E *= pow(0.45, uDt);
  vec2 perp = vec2(-uWindDir.y, uWindDir.x);
  for (int i = 0; i < ${MAX_GUSTS}; i++) {
    if (i >= uGustCount) break;
    vec4 g = uGusts[i]; float age = g.z;
    vec2 c = vec2(g.x*uAspect, g.y) + uWindDir*age*0.18;
    vec2 d = p - c;
    float along = dot(d, uWindDir), across = dot(d, perp);
    float r = uGustR[i];
    float wide = 1.0 + max(along, 0.0)/r*0.6;           // 下風處展開成扇形
    float shape = exp(-along*along/(r*r*0.8) - across*across/(r*r*0.3*wide*wide));
    float brk = 0.45 + 0.55*(gnoise(p*8.0 - uWindDir*uTime*1.2 + float(i)*7.3)*0.5+0.5); // 打碎成貓爪狀
    float env = smoothstep(0.0, 0.1, age) * (1.0 - smoothstep(0.3, ${GUST_LIFE.toFixed(1)}, age));
    E += g.w * shape * brk * env * uDt * 5.0;
  }
  o = vec4(min(E, 4.0), 0.0, 0.0, 1.0);
}`;

  var HEIGHT_FS = COMMON + `
uniform sampler2D uE; uniform float uFlowT, uAspect, uWind, uPatchT, uPatchSize, uVar; uniform vec2 uWindDir;
// 風斑：順風移動的一塊塊區域，蓋到的地方波比較碎，其他地方接近鏡面
float patchAmp(vec2 p){
  vec2 perp = vec2(-uWindDir.y, uWindDir.x);
  vec2 w = vec2(dot(p, uWindDir)*0.6, dot(p, perp)) / uPatchSize - vec2(uPatchT, 0.0);
  float n = gnoise(w)*0.7 + gnoise(w*2.1 + vec2(7.0, 3.0) - vec2(uPatchT*0.4, 0.0))*0.3;
  float pm = smoothstep(-0.22, 0.32, n);
  return mix(1.0, pm*1.8, clamp(uVar, 0.0, 1.0));
}
float ripples(vec2 p, float t, float freq){
  vec2 perp = vec2(-uWindDir.y, uWindDir.x);
  vec2 w = vec2(dot(p, uWindDir), dot(p, perp));
  w += 0.3*vec2(gnoise(p*1.3 + t*0.05), gnoise(p*1.3 + vec2(5.2,1.3) - t*0.04));
  // 波峰與風向垂直：順風方向頻率高、橫向拉長
  vec2 q = vec2(w.x*freq*1.7, w.y*freq*0.5) - vec2(t*freq*0.3, 0.0);
  return gnoise(q)*0.6 + gnoise(q*2.03 + vec2(3.1,7.7))*0.28 + gnoise(q*4.1 + vec2(1.7,2.9))*0.12;
}
void main(){
  vec2 p = vec2(vUv.x*uAspect, vUv.y);
  p.y *= mix(1.25, 0.85, vUv.y); // 輕微透視：上方（遠處）波紋較密
  float t = uFlowT;
  float E = texture(uE, vUv).r;
  float swell = gnoise(p*1.1 - uWindDir*t*0.12)*0.6 + gnoise(p*2.3 + vec2(4,1) - uWindDir*t*0.2)*0.3;
  float amp = patchAmp(p);
  float h = swell*(0.35 + 0.5*uWind)*mix(1.0, amp, 0.4)
          + ripples(p, t, 6.0)*uWind*0.9*amp
          + ripples(p*1.6 + 3.0, t*1.8, 10.0)*(E*0.6 + uWind*0.15*amp);
  o = vec4(h, E, amp, 1.0);
}`;

  var COMP_FS = COMMON + `
uniform sampler2D uImg, uMask, uH, uPrev, uE; uniform int uHasMask; uniform float uSoften;
uniform vec2 uImgScale, uTexelH, uWindDir, uLight; uniform vec3 uGlintColor; uniform vec4 uKey; uniform float uDarkW;
uniform float uChaos, uChaosAt, uFlowT, uSwirl, uAspect, uTime, uWind, uDistort, uSway, uGlint, uEcho, uFade, uDragLen, uEchoBlur;
uniform vec2 uTexelF;
vec2 toImg(vec2 uv){ return (uv - 0.5)*uImgScale + 0.5; }
vec2 p2uv(vec2 v){ return vec2(v.x/uAspect, v.y); }
float swayMask(vec2 iuv){
  if (uHasMask == 1) return textureLod(uMask, iuv, 2.0).r;
  vec3 c = textureLod(uImg, iuv, 4.5).rgb;
  float blue = smoothstep(uKey.x, uKey.y, c.b - max(c.r, c.g*0.85));
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  float dark = 1.0 - smoothstep(uKey.z, uKey.w, lum);
  return max(blue, dark*uDarkW);
}
// 模糊過的陣風能量：決定擾動與殘影的切換，讓清楚區到殘影區是寬的漸層而不是一條邊
float softE(){
  float r = 0.015 + 0.09*uSoften, sum = 0.0, wsum = 0.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec2 k = vec2(float(i), float(j));
    float w = exp(-dot(k, k)*0.35);
    sum += texture(uE, vUv + k*0.5*r*vec2(1.0/uAspect, 1.0)).r*w; wsum += w;
  }
  return sum/wsum;
}
void main(){
  vec4 H = texture(uH, vUv);
  vec4 hx1 = texture(uH, vUv + vec2(uTexelH.x, 0)), hx0 = texture(uH, vUv - vec2(uTexelH.x, 0));
  vec4 hy1 = texture(uH, vUv + vec2(0, uTexelH.y)), hy0 = texture(uH, vUv - vec2(0, uTexelH.y));
  vec2 grad  = vec2((hx1.r - hx0.r)/(2.0*uTexelH.x*uAspect), (hy1.r - hy0.r)/(2.0*uTexelH.y)); // 每單位（高=1）
  vec2 gradE = vec2((hx1.g - hx0.g)/(2.0*uTexelH.x*uAspect), (hy1.g - hy0.g)/(2.0*uTexelH.y));
  float E = H.g;
  vec2 perp = vec2(-uWindDir.y, uWindDir.x);
  float windLocal = uWind*H.b + E*0.8;

  // 倒影扭曲：垂直方向較強（倒影被波紋拉長的感覺）
  vec2 off = p2uv(grad*vec2(0.55, 1.0)) * 0.0022 * uDistort;
  // 陣風推移 + 繞著陣風區的旋轉（gradE 的垂直向量）
  vec2 push = p2uv(uWindDir*E*0.012 + vec2(-gradE.y, gradE.x)*0.006*uSwirl);
  // 荷花擺動（倒影裡的花一起被吹動）
  float m = swayMask(toImg(vUv));
  float ph = gnoise(vUv*vec2(uAspect, 1.0)*1.4)*6.0;
  float osc = sin(uTime*1.15 + ph)*0.6 + sin(uTime*0.5 + ph*1.7)*0.4;
  vec2 sway = p2uv(uWindDir*(0.45 + 0.55*osc) + perp*0.3*osc) * windLocal * 0.011 * uSway * m;

  // 劇烈擾動：局部風力超過門檻後，疊上大幅度多層扭曲（domain warp），畫面折疊成大理石紋般的團塊
  // 常駐風開到最大時全畫面都會到達；陣風經過的區域也會短暫到達
  // 門檻用模糊能量＋較寬的 smoothstep（uSoften 越大越寬），避免擾動與殘影在陣風邊緣突然切換
  float windSoft = uWind*H.b + softE()*0.8;
  float level = max(uWind, windSoft);
  float ramp = 0.1 + 0.5*uSoften;
  float chaos = smoothstep(uChaosAt - ramp*0.5, max(uChaosAt + 0.1, 1.0) + ramp, level) * uChaos;
  if (chaos > 0.001) {
    vec2 pp = vec2(vUv.x*uAspect, vUv.y);
    vec2 q = pp*2.8 - uWindDir*uFlowT*0.12;
    vec2 w1 = vec2(gnoise(q), gnoise(q + vec2(5.2, 1.3)));
    vec2 q2 = q*1.7 + 3.2*w1 + uWindDir*uFlowT*0.05;
    vec2 w2 = vec2(gnoise(q2 + vec2(1.7, 9.2)), gnoise(q2 + vec2(8.3, 2.8)));
    vec2 w3 = vec2(gnoise(q2*2.3 + 1.8*w2), gnoise(q2*2.3 + 1.8*w2 + vec2(3.1, 4.7)));
    vec2 edge = smoothstep(vec2(0.0), vec2(0.12), min(vUv, 1.0 - vUv));
    off += p2uv(w1*0.3 + w2*0.4 + w3*0.3) * 0.14 * chaos * mix(0.45, 1.0, edge.x*edge.y);
  }

  vec2 iuv = toImg(vUv + off - push - sway);
  float rough = clamp(length(grad)*0.035*uDistort, 0.0, 1.0) * (1.0 - 0.7*min(chaos, 1.0));
  vec3 col = textureLod(uImg, iuv, rough*1.8).rgb;
  // 擾動強時明暗對比拉高一點，接近參考圖的亮帶與深色團塊
  col = mix(col, smoothstep(0.03, 0.97, col), 0.5*min(chaos, 1.0));

  // 水面閃光：法線朝光源傾斜、且底下是亮水面的地方
  float bright = smoothstep(0.55, 0.85, dot(col, vec3(0.299, 0.587, 0.114)));
  float tilt = dot(grad, normalize(uLight)) * 0.12;
  float spark = smoothstep(0.7, 1.0, tilt) * (0.5 + 0.5*hash1(floor(vUv*vec2(uAspect,1.0)*900.0)));
  col += uGlintColor * spark * bright * uGlint * (0.25 + windLocal) * 0.9;

  // 殘影：上一幀順風被拖曳，與當幀混合；固定點永遠是當幀 → 不會累積過亮或糊掉
  // 每幀保留比例 = uEcho ×（1 − 0.6 × uFade）；uDragLen 放大每幀被風推的距離（拖曳條紋長度）
  vec2 drag = (p2uv(uWindDir*(0.0003 + 0.0016*mix(windLocal, windSoft, uSoften))) + push*0.12) * uDragLen;
  // 殘影模糊：上一幀先做 9 點模糊再疊回，每幀累積 → 殘影像水彩暈開（uEchoBlur = 模糊半徑，單位像素）
  vec2 pu = vUv - drag;
  vec3 prev = texture(uPrev, pu).rgb;
  if (uEchoBlur > 0.01) {
    vec2 r = uTexelF * uEchoBlur;
    vec3 cross = texture(uPrev, pu + vec2(r.x, 0)).rgb + texture(uPrev, pu - vec2(r.x, 0)).rgb
               + texture(uPrev, pu + vec2(0, r.y)).rgb + texture(uPrev, pu - vec2(0, r.y)).rgb;
    vec3 diag = texture(uPrev, pu + r).rgb + texture(uPrev, pu - r).rgb
              + texture(uPrev, pu + vec2(r.x, -r.y)).rgb + texture(uPrev, pu + vec2(-r.x, r.y)).rgb;
    prev = prev*0.25 + cross*0.125 + diag*0.0625;
  }
  prev = mix(prev, col, uFade*0.6);
  o = vec4(mix(col, prev, uEcho*(1.0 - 0.6*min(chaos, 1.0))), 1.0);
}`;

  var PRESENT_FS = COMMON + `
uniform sampler2D uFb; uniform vec2 uRes; uniform float uTime;
void main(){
  vec3 c = texture(uFb, vUv).rgb;
  c += (hash1(vUv*uRes + fract(uTime)*91.7) - 0.5)*0.022;
  float v = 1.0 - smoothstep(0.45, 1.25, length((vUv - 0.5)*vec2(1.15, 1.0))*1.4);
  c *= mix(0.84, 1.0, v);
  o = vec4(c, 1.0);
}`;

  var progs = {
    gust: program(GUST_FS), height: program(HEIGHT_FS),
    comp: program(COMP_FS), present: program(PRESENT_FS),
  };
  if (!progs.gust || !progs.height || !progs.comp || !progs.present) return;

  var vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  var vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  // ---------- textures ----------
  var img = { tex: null, w: 1, h: 1 }, mask = { tex: null };
  loadImage(scene.image, function (im) {
    img.loaded = true;
    img.tex = imageTexture(im); img.w = im.naturalWidth; img.h = im.naturalHeight;
  });
  if (scene.mask) loadImage(scene.mask, function (im) { mask.tex = imageTexture(im); });

  var T = {}; // render targets
  var W = 0, Hh = 0;
  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    var w = Math.max(2, Math.round(canvas.clientWidth * dpr));
    var h = Math.max(2, Math.round(canvas.clientHeight * dpr));
    if (w === W && h === Hh) return;
    W = w; Hh = h; canvas.width = w; canvas.height = h;
    var gw = Math.min(384, Math.round(w / 4)), gh = Math.max(2, Math.round(gw * h / w));
    var hw = Math.min(1024, Math.round(w / 2)), hh = Math.max(2, Math.round(hw * h / w));
    Object.keys(T).forEach(function (k) { gl.deleteTexture(T[k].tex); gl.deleteFramebuffer(T[k].fb); });
    T = {
      gA: target(gw, gh), gB: target(gw, gh),
      h: target(hw, hh),
      fA: target(w, h), fB: target(w, h),
    };
    fbPrimed = false;
  }
  var fbPrimed = false;

  // ---------- gusts ----------
  var gusts = [];
  canvas.addEventListener('pointerdown', function (e) {
    var r = canvas.getBoundingClientRect();
    addGust((e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height, P.gust, P.gustSize);
  });
  function addGust(x, y, s, r) {
    gusts.push({ x: x, y: y, t0: now, s: s, r: r });
    if (gusts.length > MAX_GUSTS) gusts.shift();
  }
  // 自動陣風：平均每分鐘 autoRate 次（Poisson），從上風處隨機位置出發
  function autoGusts(dt) {
    if (P.autoRate <= 0 || P.autoGust <= 0) return;
    if (Math.random() < dt * P.autoRate / 60) {
      var x = 0.5 - windDir[0] * 0.3 + (Math.random() - 0.5) * 0.6;
      var y = 0.5 - windDir[1] * 0.3 + (Math.random() - 0.5) * 0.9;
      addGust(x, y, P.autoGust * (0.6 + Math.random() * 0.6), P.autoSize * (0.7 + Math.random() * 0.6));
    }
  }
  // 風力的時間變化：多層慢速 1D 雜訊，往上衝的比往下掉的明顯（陣風感）
  function vnoise(x) {
    var i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
    var a = rand(i), b = rand(i + 1);
    return (a + (b - a) * u) * 2 - 1;
  }
  function rand(i) { var s = Math.sin(i * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }
  // 節拍擾動：依 scene.beat.map（分段 BPM，拍點 = offset + k × 60/bpm，秒數以配樂 0 秒起算），
  // 每拍風力瞬間增強再指數退去；每小節第一拍加強
  // 時間軸播放時用時間軸時間（和配樂對齊），暫停時用自由時鐘預覽
  function beatPulse() {
    var b = scene.beat;
    if (!b || !b.map || !(P.beatAmt > 0)) return 0;
    // 用哪一段看時間軸位置；拍子相位播放時跟時間軸，暫停時用自由時鐘預覽
    var seg = b.map[0];
    for (var i = 1; i < b.map.length; i++) if (api.time >= b.map[i].from) seg = b.map[i];
    if (seg.off) return 0;
    var time = api.playing ? api.time : freeT;
    var period = 60 / seg.bpm, per = b.perBar || 4;
    var bt = time - (seg.offset || 0);
    var n = Math.floor(bt / period), ph = bt - n * period;
    var accent = ((n % per) + per) % per === 0 ? 1 + (P.beatAccent || 0) : 1;
    return P.beatAmt * accent * Math.exp(-ph * (P.beatDecay || 5));
  }
  // 節奏風：依配樂節奏強度曲線（scene.rhythm → window.WIND_RHYTHM），節奏密集時風慢慢吹起、停下來就慢慢退
  var rhythm = scene.rhythm && window.WIND_RHYTHM ? window.WIND_RHYTHM[scene.rhythm] : null;
  var rhythmLevel = 0;
  function rhythmAt(time) {
    if (!rhythm) return 0;
    var x = time * rhythm.rate, i = Math.floor(x), d = rhythm.data;
    if (i < 0) return d[0] / 99;
    if (i >= d.length - 1) return d[d.length - 1] / 99;
    return (d[i] + (d[i + 1] - d[i]) * (x - i)) / 99;
  }
  function rhythmWind(dt) {
    if (!rhythm || !(P.rhythmAmt > 0)) { rhythmLevel = 0; return 0; }
    var target = rhythmAt(api.time);
    var tau = target > rhythmLevel ? (P.rhythmAttack || 1) : (P.rhythmRelease || 3);
    rhythmLevel += (target - rhythmLevel) * (1 - Math.exp(-dt / tau));
    return P.rhythmAmt * rhythmLevel;
  }
  // 音量扭曲：AE 匯出的音量曲線（window.WIND_CURVES）加到倒影扭曲；尖峰立刻起、依退去時間平滑退回
  var dcfg = scene.distortCurve || null;
  var dcurve = dcfg && window.WIND_CURVES ? window.WIND_CURVES[dcfg.name] : null;
  var dLevel = 0;
  function curveAt(c, time) {
    var x = time * c.rate, i = Math.floor(x), d = c.data;
    if (i < 0 || i >= d.length - 1) return 0;
    return (d[i] + (d[i + 1] - d[i]) * (x - i)) / c.max;
  }
  function audioDistort(dt) {
    if (!dcurve || !(P.audioDistort > 0)) { dLevel = 0; return 0; }
    var target = curveAt(dcurve, api.time + (dcfg.offset || 0));
    var rel = P.audioRelease || 0;
    dLevel = Math.max(target, rel > 0 ? dLevel * Math.exp(-dt / rel) : 0);
    return P.audioDistort * dLevel;
  }
  function windAt(tt) {
    var g = vnoise(tt * 0.25) * 0.55 + vnoise(tt * 0.7 + 11) * 0.3 + vnoise(tt * 1.9 + 23) * 0.15;
    g = g > 0 ? g * 1.5 : g * 0.8;
    return Math.min(1.5, P.wind * Math.max(0.05, 1 + P.gustVar * g));
  }

  // ---------- loop ----------
  var freeT = 0, now = 0, last = performance.now(), flowT = 0, swayT = 0, varT = Math.random() * 100, patchT = 0;
  var windNow = P.wind, meter = null, meterTick = 0;
  var gustData = new Float32Array(MAX_GUSTS * 4), gustR = new Float32Array(MAX_GUSTS);
  var ang = (scene.windAngle || 0) * Math.PI / 180;
  var windDir = [Math.cos(ang), Math.sin(ang)];
  var light = norm(scene.light || [0, 1]);
  var key = scene.swayKey || { blue: [0.04, 0.2], dark: [0.12, 0.3], darkWeight: 0.5 };

  // 繪圖環境遺失（GPU 重置、分頁太多等）：顯示提示，恢復時重新整理（key 已暫存在瀏覽器，不會遺失）
  var ctxLost = false, waitShown = null;
  var LOST_MSG = '繪圖環境（WebGL）無法使用，畫面暫停。恢復後會自動重新整理；若一直沒恢復，請關掉整個瀏覽器再開（Chrome 在顯示卡出錯後會暫時封鎖 WebGL）。';
  canvas.addEventListener('webglcontextlost', function (e) {
    e.preventDefault(); ctxLost = true; notice(LOST_MSG);
  });
  canvas.addEventListener('webglcontextrestored', function () { location.reload(); });
  function frame(t) {
    requestAnimationFrame(frame);
    var dt = Math.min(0.05, Math.max(0.001, (t - last) / 1000));
    last = t; now += dt;
    resize();
    // 時間軸（含配樂、定時陣風）先走，不受畫面狀態影響
    if (api.tick) api.tick(dt);
    // 開頁就拿到已遺失的環境時不會觸發 webglcontextlost，要主動檢查
    if (!ctxLost && gl.isContextLost()) { ctxLost = true; notice(LOST_MSG); }
    if (ctxLost) return;
    if (!img.tex) {
      // 圖已下載但建不了貼圖 = WebGL 不能用；否則超過 2 秒顯示載入中
      var msg = img.loaded ? LOST_MSG : now > 2 ? '底圖載入中…（' + scene.image + '）' : null;
      if (msg !== waitShown) { waitShown = msg; notice(msg); }
      return;
    }
    if (waitShown) { waitShown = null; notice(null); }
    varT += dt * P.gustPace;
    freeT += dt;
    // 節拍只加強水波與倒影扭曲，不算進擾動門檻的風力（否則重拍疊上陣風高峰會整個畫面瞬間抽象化）
    var rw = rhythmWind(dt);
    windNow = windAt(varT) + rw;
    var beat = beatPulse();
    var ad = audioDistort(dt);
    flowT += dt * P.flow * (0.6 + windNow);
    patchT += dt * (0.05 + 0.2 * windNow) * (0.5 + P.flow * 0.5) / P.patchSize;
    swayT += dt * (0.5 + P.flow * 0.5);
    var aspect = W / Hh;

    autoGusts(dt);
    gusts = gusts.filter(function (g) { return now - g.t0 < GUST_LIFE; });
    for (var i = 0; i < gusts.length; i++) {
      gustData.set([gusts[i].x, gusts[i].y, now - gusts[i].t0, gusts[i].s], i * 4);
      gustR[i] = gusts[i].r;
    }
    if (meter && (meterTick += dt) > 0.1) { meterTick = 0; meter.textContent = '目前風力 ' + windNow.toFixed(2) + (rw > 0.005 ? '（節奏 ' + rw.toFixed(2) + '）' : '') + (beat > 0.005 ? ' ＋拍 ' + beat.toFixed(2) : '') + (ad > 0.005 ? ' 扭曲＋' + ad.toFixed(2) : ''); }

    // 1. gust energy
    use(progs.gust, T.gB);
    tex(progs.gust, 'uPrev', T.gA.tex, 0);
    u2(progs.gust, 'uTexel', 1 / T.gA.w, 1 / T.gA.h);
    u1(progs.gust, 'uDt', dt); u1(progs.gust, 'uTime', now); u1(progs.gust, 'uAspect', aspect);
    u1(progs.gust, 'uWind', windNow); u1(progs.gust, 'uSwirl', P.swirl || 0);
    u2(progs.gust, 'uWindDir', windDir[0], windDir[1]);
    gl.uniform4fv(loc(progs.gust, 'uGusts'), gustData);
    gl.uniform1fv(loc(progs.gust, 'uGustR'), gustR);
    gl.uniform1i(loc(progs.gust, 'uGustCount'), gusts.length);
    draw();
    var sw = T.gA; T.gA = T.gB; T.gB = sw;

    // 2. height
    use(progs.height, T.h);
    tex(progs.height, 'uE', T.gA.tex, 0);
    u1(progs.height, 'uFlowT', flowT); u1(progs.height, 'uAspect', aspect); u1(progs.height, 'uWind', windNow + beat);
    u1(progs.height, 'uPatchT', patchT); u1(progs.height, 'uPatchSize', P.patchSize); u1(progs.height, 'uVar', P.gustVar);
    u2(progs.height, 'uWindDir', windDir[0], windDir[1]);
    draw();

    // 3. composite + feedback
    var c = progs.comp;
    use(c, T.fB);
    tex(c, 'uImg', img.tex, 0); tex(c, 'uMask', mask.tex || img.tex, 1);
    tex(c, 'uH', T.h.tex, 2); tex(c, 'uPrev', T.fA.tex, 3); tex(c, 'uE', T.gA.tex, 4);
    gl.uniform1i(loc(c, 'uHasMask'), mask.tex ? 1 : 0);
    var ia = img.w / img.h;
    if (aspect > ia) u2(c, 'uImgScale', 1, ia / aspect); else u2(c, 'uImgScale', aspect / ia, 1);
    u2(c, 'uTexelH', 1 / T.h.w, 1 / T.h.h);
    u2(c, 'uWindDir', windDir[0], windDir[1]); u2(c, 'uLight', light[0], light[1]);
    gl.uniform3fv(loc(c, 'uGlintColor'), scene.glintColor || [1, 0.9, 0.7]);
    gl.uniform4f(loc(c, 'uKey'), key.blue[0], key.blue[1], key.dark[0], key.dark[1]);
    u1(c, 'uDarkW', key.darkWeight);
    u1(c, 'uAspect', aspect); u1(c, 'uSwirl', P.swirl || 0); u1(c, 'uChaos', P.chaos || 0); u1(c, 'uChaosAt', P.chaosAt || 0.5); u1(c, 'uSoften', P.soften == null ? 0.5 : P.soften); u1(c, 'uFlowT', flowT); u1(c, 'uTime', swayT); u1(c, 'uWind', windNow);
    u1(c, 'uDistort', (P.distort + ad) * (1 + beat * 1.5)); u1(c, 'uSway', P.sway); u1(c, 'uGlint', P.glint);
    u1(c, 'uEcho', fbPrimed ? P.echo : 0); u1(c, 'uFade', P.fade); u1(c, 'uDragLen', P.dragLen == null ? 1 : P.dragLen);
    u1(c, 'uEchoBlur', P.echoBlur || 0); u2(c, 'uTexelF', 1 / W, 1 / Hh);
    draw();
    sw = T.fA; T.fA = T.fB; T.fB = sw; fbPrimed = true;

    // 4. present
    use(progs.present, null);
    tex(progs.present, 'uFb', T.fA.tex, 0);
    u2(progs.present, 'uRes', W, Hh); u1(progs.present, 'uTime', now);
    draw();
  }
  requestAnimationFrame(frame);

  // ---------- panel ----------
  // 給 timeline.js 用的介面：讀寫參數、同步滑桿、得知使用者手動調整
  var api = window.WIND_API = {
    scene: scene, params: PARAMS.filter(function (d) { return d.key; }), P: P,
    rows: {}, tick: null, onUserInput: null, onReset: null, time: 0, playing: false,
    gust: function (x, y, s, r) { addGust(x, y, s == null ? P.gust : s, r == null ? P.gustSize : r); },
    set: function (k, v) {
      P[k] = v;
      var r = api.rows[k];
      if (r && !r.inp.matches(':active')) { r.inp.value = v; r.val.textContent = (+v).toFixed(2); }
    },
  };
  buildPanel();

  // ---------- helpers ----------
  function program(fs) {
    var p = gl.createProgram();
    [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, fs]].forEach(function (s) {
      var sh = gl.createShader(s[0]);
      gl.shaderSource(sh, s[1]); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(sh));
      gl.attachShader(p, sh);
    });
    gl.bindAttribLocation(p, 0, 'a');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { fail('Shader 編譯失敗，詳見主控台。'); console.error(gl.getProgramInfoLog(p)); return null; }
    p._loc = {};
    return p;
  }
  function loc(p, n) { if (!(n in p._loc)) p._loc[n] = gl.getUniformLocation(p, n); return p._loc[n]; }
  function u1(p, n, v) { gl.uniform1f(loc(p, n), v); }
  function u2(p, n, a, b) { gl.uniform2f(loc(p, n), a, b); }
  function tex(p, n, t, unit) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(loc(p, n), unit); }
  function use(p, tgt) {
    gl.useProgram(p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, tgt ? tgt.fb : null);
    gl.viewport(0, 0, tgt ? tgt.w : W, tgt ? tgt.h : Hh);
  }
  function draw() { gl.drawArrays(gl.TRIANGLES, 0, 3); }
  function target(w, h) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    if (floatOK) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    var fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex: t, fb: fb, w: w, h: h };
  }
  function imageTexture(im) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
    return t;
  }
  function loadImage(src, cb) {
    var im = new Image();
    im.onload = function () { cb(im); };
    im.onerror = function () { fail('素材載入失敗：' + src); };
    im.src = src;
  }
  function norm(v) { var l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; }
  // 非錯誤的狀態提示（msg = null 時隱藏）；不覆蓋已顯示的錯誤
  function notice(msg) {
    var el = document.getElementById('error');
    if (!el || el.dataset.fatal) return;
    el.textContent = msg || ''; el.hidden = !msg;
  }
  function fail(msg) {
    var el = document.getElementById('error');
    if (el) { el.textContent = msg; el.hidden = false; el.dataset.fatal = '1'; }
  }

  function buildPanel() {
    var panel = document.getElementById('panel');
    var body = panel.querySelector('.body');
    document.getElementById('scene-title').textContent = scene.title;
    var sel = document.getElementById('scene-select');
    scenes.forEach(function (s) {
      var op = document.createElement('option');
      op.value = s.id; op.textContent = s.title; op.selected = s === scene;
      sel.appendChild(op);
    });
    sel.hidden = scenes.length < 2;
    sel.addEventListener('change', function () { location.search = '?scene=' + encodeURIComponent(sel.value); });

    var inputs = {};
    var SLIDERS = PARAMS.filter(function (d) { return d.key; });
    PARAMS.forEach(function (d) {
      if (d.head) {
        var hd = document.createElement('div');
        hd.className = 'group'; hd.textContent = d.head;
        body.appendChild(hd);
        return;
      }
      var row = document.createElement('label');
      row.className = 'row';
      row.innerHTML = '<span class="name"></span><input type="range"><span class="val"></span>';
      row.querySelector('.name').textContent = d.label;
      var inp = row.querySelector('input'), val = row.querySelector('.val');
      inp.min = d.min; inp.max = d.max; inp.step = d.step; inp.value = P[d.key];
      val.textContent = (+P[d.key]).toFixed(2);
      inp.addEventListener('input', function () {
        var before = P[d.key];
        P[d.key] = +inp.value; val.textContent = (+inp.value).toFixed(2);
        if (api.onUserInput) api.onUserInput(d.key, before);
      });
      inputs[d.key] = api.rows[d.key] = { inp: inp, val: val, row: row };
      body.appendChild(row);
    });

    document.getElementById('reset').addEventListener('click', function () {
      Object.assign(P, scene.params);
      SLIDERS.forEach(function (d) { inputs[d.key].inp.value = P[d.key]; inputs[d.key].val.textContent = (+P[d.key]).toFixed(2); });
      if (api.onReset) api.onReset();
    });
    meter = document.getElementById('meter');
    var copyBtn = document.getElementById('copy');
    copyBtn.addEventListener('click', function () {
      var out = {};
      SLIDERS.forEach(function (d) { out[d.key] = +(+P[d.key]).toFixed(2); });
      var text = JSON.stringify(out);
      var done = function () { copyBtn.textContent = '已複製'; setTimeout(function () { copyBtn.textContent = '複製參數'; }, 1200); };
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () { prompt('參數', text); });
      else prompt('參數', text);
    });
    function toggle() { panel.classList.toggle('collapsed'); }
    document.getElementById('toggle').addEventListener('click', toggle);
    window.addEventListener('keydown', function (e) { if (e.key === 'h' || e.key === 'H') toggle(); });
  }
})();
