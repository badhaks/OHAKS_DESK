/**
 * OHAKS_Desk — KIS API 공유 모듈
 * 모든 페이지에서 window.KIS.* 로 사용
 */
(function(){
'use strict';

const BASE = 'https://openapi.koreainvestment.com:9443';
// 참고: KIS API는 CORS 허용 안 함 → 반드시 프록시 필요
// 로컬 서버(Python Flask)로 실행하면 프록시 불필요
// 로컬 프록시 우선 → 공개 프록시 fallback
const LOCAL_PROXY = 'http://localhost:8765';
let _localProxyOk = null; // null=미확인 true/false

async function _checkLocalProxy(){
  if(_localProxyOk !== null) return _localProxyOk;
  try{
    const r = await fetch(`${LOCAL_PROXY}/oauth2/tokenP`, {
      method:'POST', signal:AbortSignal.timeout(1500),
      headers:{'Content-Type':'application/json'},
      body:'{}',
    });
    // 400/401은 서버가 살아있다는 뜻
    _localProxyOk = (r.status < 500);
  } catch(_){ _localProxyOk = false; }
  console.log('[KIS] 로컬 프록시:', _localProxyOk ? '✓ 연결됨' : '✗ 없음 → 공개 프록시 사용');
  return _localProxyOk;
}

const PROXIES = [
  url => url.replace('https://openapi.koreainvestment.com:9443', LOCAL_PROXY),
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
];

// ── State ──
let _appkey    = localStorage.getItem('kis_appkey')    || '';
let _appsecret = localStorage.getItem('kis_appsecret') || '';
let _accno     = localStorage.getItem('kis_accno')     || '';
let _token     = localStorage.getItem('kis_token')     || '';
let _tokenExp  = parseInt(localStorage.getItem('kis_token_exp') || '0');
let _onStatusChange = null; // callback(msg, type)

// ── Public API ──
const KIS = {

  // ── Config ──
  isConfigured(){ return !!(_appkey && _appsecret); },
  isTokenValid(){ return !!_token && Date.now() < _tokenExp - 60000; },
  getKeys(){ return { appkey:_appkey, appsecret:_appsecret, accno:_accno }; },

  saveKeys(appkey, appsecret, accno){
    _appkey=appkey; _appsecret=appsecret; _accno=accno;
    localStorage.setItem('kis_appkey',    appkey);
    localStorage.setItem('kis_appsecret', appsecret);
    localStorage.setItem('kis_accno',     accno||'');
  },

  onStatus(cb){ _onStatusChange = cb; },

  _status(msg, type='load'){
    console.log(`[KIS] ${msg}`);
    if(_onStatusChange) _onStatusChange(msg, type);
  },

  // ── Token ──
  async getToken(force=false){
    if(!force && this.isTokenValid()) return true;
    if(!_appkey || !_appsecret){ this._status('App Key/Secret 없음','err'); return false; }
    this._status('토큰 발급 중...');
    const body = JSON.stringify({grant_type:'client_credentials', appkey:_appkey, appsecret:_appsecret});
    // 로컬 프록시 우선 확인
    await _checkLocalProxy();
    const proxyList = _localProxyOk ? PROXIES : PROXIES.slice(1);
    for(const proxyFn of proxyList){
      const url = proxyFn(`${BASE}/oauth2/tokenP`);
      try{
        this._status(`토큰 발급 중... (${proxyFn.toString().match(/https:\/\/[^/`']+/)?.[0]||'proxy'})`);
        const r = await fetch(url, {
          method: 'POST',
          headers: {'Content-Type':'application/json', 'x-cors-api-key':'temp_...'},
          body,
          signal: AbortSignal.timeout(15000),
        });
        if(!r.ok){ console.warn('[KIS token] HTTP', r.status, url.slice(0,60)); continue; }
        const j = await r.json();
        if(!j?.access_token){ console.warn('[KIS token] no token:', j); continue; }
        _token    = j.access_token;
        _tokenExp = Date.now() + (j.expires_in||86400)*1000;
        localStorage.setItem('kis_token',     _token);
        localStorage.setItem('kis_token_exp', String(_tokenExp));
        this._status('토큰 발급 완료 ✓','ok');
        return true;
      } catch(e){ console.warn('[KIS token] proxy fail:', e.message); }
    }
    this._status('토큰 발급 실패 — 모든 프록시 차단됨. 아래 직접 방식 시도','err');
    return false;
  },

  // ── Low-level request ──
  async _get(path, params, trId, custtype='P'){
    if(!await this.getToken()) return null;
    const rawUrl = `${BASE}${path}?${new URLSearchParams(params)}`;
    const proxyList = _localProxyOk ? PROXIES : (_localProxyOk===false ? PROXIES.slice(1) : PROXIES);
    for(const proxyFn of proxyList){
      try{
        const r = await fetch(proxyFn(rawUrl), {
          headers:{
            'authorization': `Bearer ${_token}`,
            'appkey':        _appkey,
            'appsecret':     _appsecret,
            'tr_id':         trId,
            'custtype':      custtype,
          },
          signal: AbortSignal.timeout(12000),
        });
        if(!r.ok){ console.warn('[KIS]', trId, r.status); continue; }
        const j = await r.json();
        if(j?.rt_cd && j.rt_cd !== '0'){ console.warn('[KIS]', trId, j.msg1); return null; }
        return j;
      } catch(e){ console.warn('[KIS]', trId, e.message); }
    }
    return null;
  },

  // ═══════════════════════════════════════
  // 국내주식 현재가
  // ═══════════════════════════════════════
  // ═══════════════════════════════════════
  // 국내 지수 현재가 (KOSPI=0001, KOSDAQ=1001)
  // ═══════════════════════════════════════
  async getIndex(idxCode='0001'){
    const j = await this._get(
      '/uapi/domestic-stock/v1/quotations/inquire-index-price',
      {FID_COND_MRKT_DIV_CODE:'U', FID_INPUT_ISCD:idxCode},
      'FHPUP02100000'
    );
    if(!j?.output) return null;
    const o = j.output;
    const n = s => parseFloat((s||'0').replace(/,/g,''));
    return {
      cur:    n(o.bstp_nmix_prpr),   // 현재가
      prev:   n(o.bstp_nmix_prdy_clpr), // 전일종가
      chg:    n(o.bstp_nmix_prdy_vrss), // 전일대비
      chgPct: n(o.prdy_ctrt),            // 등락률(%)
      high:   n(o.bstp_nmix_hgpr),
      low:    n(o.bstp_nmix_lwpr),
      open:   n(o.bstp_nmix_oprc),
      vol:    n(o.acml_vol),
      source: 'KIS',
    };
  },

  async quoteKR(code){
    code = code.replace('.KS','').replace('.KQ','');
    const j = await this._get(
      '/uapi/domestic-stock/v1/quotations/inquire-price',
      {FID_COND_MRKT_DIV_CODE:'J', FID_INPUT_ISCD:code},
      'FHKST01010100'
    );
    if(!j?.output) return null;
    const o = j.output;
    const n = s => parseFloat((s||'0').replace(/,/g,''));
    return {
      code,
      cur:    n(o.stck_prpr),   // 현재가
      prev:   n(o.stck_sdpr),   // 기준가(전일종가)
      open:   n(o.stck_oprc),   // 시가
      high:   n(o.stck_hgpr),   // 고가
      low:    n(o.stck_lwpr),   // 저가
      chg:    n(o.prdy_vrss),   // 전일대비
      chgPct: n(o.prdy_ctrt),   // 전일대비율(%)
      vol:    n(o.acml_vol),    // 거래량
      mktCap: n(o.hts_avls),    // 시가총액(억)
      per:    n(o.per),
      pbr:    n(o.pbr),
      eps:    n(o.eps),
      name:   o.hts_kor_isnm,
      sign:   o.prdy_vrss_sign, // 1:상한 2:상승 3:보합 4:하한 5:하락
      source: 'KIS',
    };
  },

  // ═══════════════════════════════════════
  // 국내주식 호가창
  // ═══════════════════════════════════════
  async orderbookKR(code){
    code = code.replace('.KS','').replace('.KQ','');
    const j = await this._get(
      '/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn',
      {FID_COND_MRKT_DIV_CODE:'J', FID_INPUT_ISCD:code},
      'FHKST01010200'
    );
    if(!j?.output1) return null;
    const o = j.output1;
    const n = s => parseFloat((s||'0').replace(/,/g,''));
    const asks=[], bids=[];
    for(let i=1;i<=10;i++){
      asks.push({ price:n(o[`askp${i}`]),  qty:n(o[`askp_rsqn${i}`]) });
      bids.push({ price:n(o[`bidp${i}`]),  qty:n(o[`bidp_rsqn${i}`]) });
    }
    return { asks, bids,
      totalAsk: n(o.total_askp_rsqn),
      totalBid: n(o.total_bidp_rsqn),
      source: 'KIS',
    };
  },

  // ═══════════════════════════════════════
  // 해외주식 현재가 (US)
  // ═══════════════════════════════════════
  async quoteUS(sym, excd){
    // 거래소 자동 감지
    if(!excd) excd = this._detectExchange(sym);
    const j = await this._get(
      '/uapi/overseas-price/v1/quotations/price',
      {AUTH:'', EXCD:excd, SYMB:sym},
      'HHDFS00000300'
    );
    if(!j?.output) return null;
    const o = j.output;
    const n = s => parseFloat((s||'0').replace(/,/g,''));
    const cur  = n(o.last);
    const prev = n(o.base);
    return {
      sym, excd,
      cur,  prev,
      open:   n(o.open),
      high:   n(o.high),
      low:    n(o.low),
      chg:    n(o.diff),
      chgPct: n(o.rate),
      vol:    n(o.tvol),
      source: 'KIS',
    };
  },

  // ═══════════════════════════════════════
  // 해외주식 호가 (US)
  // ═══════════════════════════════════════
  async orderbookUS(sym, excd){
    if(!excd) excd = this._detectExchange(sym);
    const j = await this._get(
      '/uapi/overseas-price/v1/quotations/inquire-asking-price',
      {AUTH:'', EXCD:excd, SYMB:sym},
      'HHDFS00000200'
    );
    if(!j?.output1) return null;
    const o  = j.output1;
    const n  = s => parseFloat((s||'0').replace(/,/g,''));
    const asks=[], bids=[];
    for(let i=1;i<=10;i++){
      if(o[`pask${i}`]) asks.push({ price:n(o[`pask${i}`]), qty:n(o[`vask${i}`]) });
      if(o[`pbid${i}`]) bids.push({ price:n(o[`pbid${i}`]), qty:n(o[`vbid${i}`]) });
    }
    return { asks, bids, source:'KIS' };
  },

  // ═══════════════════════════════════════
  // 환율 (USD/KRW 등)
  // ═══════════════════════════════════════
  async fxRate(fxCode='FX@KRW'){
    // fxCode: 'FX@KRW'=달러원, 'FX@JPY'=달러엔 등
    const j = await this._get(
      '/uapi/overseas-price/v1/quotations/exchange-rate',
      {},
      'FHKST03030100'
    );
    if(!j?.output) return null;
    // output: array of FX rates
    const arr = Array.isArray(j.output) ? j.output : [j.output];
    const rates = {};
    arr.forEach(o=>{
      if(o.symb) rates[o.symb] = {
        rate: parseFloat((o.base||o.last||'0').replace(/,/g,'')),
        chg:  parseFloat((o.diff||'0').replace(/,/g,'')),
        chgPct: parseFloat((o.rate||'0')),
      };
    });
    console.log('[KIS FX]', rates);
    return rates;
  },

  // ═══════════════════════════════════════
  // 국내채권/금리 (KTB)
  // ═══════════════════════════════════════
  async bondYield(code='KR2Y'){
    // 국채 3/5/10년 현재 금리
    // KIS는 채권 전용 API 별도 — 여기선 주요 국채 ETF로 대체
    const ETF_MAP = {'KR2Y':'148070','KR3Y':'114260','KR5Y':'152380','KR10Y':'152100'};
    const etfCode = ETF_MAP[code];
    if(!etfCode) return null;
    return await this.quoteKR(etfCode);
  },

  // ═══════════════════════════════════════
  // 여러 종목 일괄 조회 (순차, 속도 제한)
  // ═══════════════════════════════════════
  async batchQuote(syms, onProgress){
    const results = {};
    for(let i=0; i<syms.length; i++){
      const sym = syms[i];
      if(onProgress) onProgress(i, syms.length, sym);
      try{
        const isKR = sym.endsWith('.KS') || sym.endsWith('.KQ') || /^\d{6}$/.test(sym);
        const q = isKR ? await this.quoteKR(sym) : await this.quoteUS(sym);
        if(q) results[sym] = q;
      } catch(e){ console.warn('[KIS batch]', sym, e.message); }
      if(i < syms.length-1) await new Promise(r=>setTimeout(r,200)); // rate limit
    }
    return results;
  },

  // ─── helper ───
  _detectExchange(sym){
    const NYSE  = ['BRK.B','JPM','GS','MS','BAC','C','WFC','V','MA','WMT','XOM','CVX','JNJ','UNH','HD'];
    const AMEX  = ['SPY','QQQ','DIA','IWM','GLD','SLV','USO'];
    if(NYSE.includes(sym))  return 'NYSE';
    if(AMEX.includes(sym))  return 'AMEX';
    return 'NASD'; // default Nasdaq
  },

  // ═══════════════════════════════════════
  // UI 헬퍼 — 공통 키 패널 렌더링
  // ═══════════════════════════════════════
  renderKeyPanel(containerId){
    const el = document.getElementById(containerId);
    if(!el) return;
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <div style="font-family:'Cormorant Garamond',Georgia,serif;font-size:18px;color:#1A1610">한국투자증권 <em style="font-style:italic;color:#0B2B52">KIS API</em></div>
        <div onclick="document.getElementById('${containerId}').closest('[id]').style.display='none'" style="font-family:'DM Mono',monospace;font-size:14px;color:#9E9585;cursor:pointer;padding:2px 6px">✕</div>
      </div>
      <div style="font-family:'DM Mono',monospace;font-size:8px;letter-spacing:.12em;text-transform:uppercase;color:#9E9585;margin-bottom:4px">App Key</div>
      <input id="kis-ui-appkey" type="text" value="${_appkey}" placeholder="KIS App Key" spellcheck="false"
        style="width:100%;padding:8px 10px;border:1px solid #DDD8CC;background:#F0ECE3;font-family:'DM Mono',monospace;font-size:11px;outline:none;margin-bottom:8px">
      <div style="font-family:'DM Mono',monospace;font-size:8px;letter-spacing:.12em;text-transform:uppercase;color:#9E9585;margin-bottom:4px">App Secret</div>
      <input id="kis-ui-secret" type="password" value="${_appsecret}" placeholder="KIS App Secret" spellcheck="false"
        style="width:100%;padding:8px 10px;border:1px solid #DDD8CC;background:#F0ECE3;font-family:'DM Mono',monospace;font-size:11px;outline:none;margin-bottom:8px">
      <div style="font-family:'DM Mono',monospace;font-size:8px;letter-spacing:.12em;text-transform:uppercase;color:#9E9585;margin-bottom:4px">계좌번호 앞 8자리</div>
      <input id="kis-ui-accno" type="text" value="${_accno}" placeholder="12345678" maxlength="8" spellcheck="false"
        style="width:100%;padding:8px 10px;border:1px solid #DDD8CC;background:#F0ECE3;font-family:'DM Mono',monospace;font-size:11px;outline:none;margin-bottom:10px">
      <div onclick="window.KIS._saveFromUI()" style="font-family:'DM Mono',monospace;font-size:9px;letter-spacing:.06em;text-transform:uppercase;padding:9px;background:#0B2B52;color:#E8DFC8;cursor:pointer;text-align:center;margin-bottom:8px">저장 + 토큰 발급</div>
      <div id="kis-ui-status" style="font-family:'DM Mono',monospace;font-size:9.5px;min-height:16px;color:#9E9585"></div>
      <div style="font-family:'DM Sans',sans-serif;font-size:10.5px;color:#9E9585;margin-top:10px;line-height:1.7;border-top:1px solid #DDD8CC;padding-top:10px">
        <strong style="color:#3D3830">발급:</strong>
        <a href="https://apiportal.koreainvestment.com" target="_blank" style="color:#0B2B52">apiportal.koreainvestment.com</a>
        → 앱 등록 → App Key/Secret 복사
      </div>`;
    this.onStatus((msg, type)=>{
      const s = document.getElementById('kis-ui-status');
      const colors={ok:'#1A6640',err:'#B83232',load:'#0B2B52',warn:'#8C6D2F'};
      if(s){ s.textContent=msg; s.style.color=colors[type]||'#9E9585'; }
    });
  },

  async _saveFromUI(){
    const k = document.getElementById('kis-ui-appkey')?.value.trim();
    const s = document.getElementById('kis-ui-secret')?.value.trim();
    const a = document.getElementById('kis-ui-accno')?.value.trim();
    if(!k||!s){ this._status('Key와 Secret을 입력하세요','err'); return; }
    this.saveKeys(k,s,a);
    _appkey=k; _appsecret=s; _accno=a||'';
    _token=''; _tokenExp=0; // force re-issue
    const ok = await this.getToken(true);
    if(ok && typeof window.onKisReady === 'function') window.onKisReady();
  },

  // badge helper
  setBadge(badgeId, active){
    const b = document.getElementById(badgeId);
    if(!b) return;
    if(active){
      b.textContent='KIS ✓'; b.style.animation='none';
      b.style.borderColor='#1A6640'; b.style.color='#1A6640';
      b.style.background='rgba(26,102,64,.06)';
    } else {
      b.textContent='⚙ KIS 설정';
    }
  },
};

window.KIS = KIS;

// Auto-init: validate saved token
if(KIS.isConfigured()){
  if(KIS.isTokenValid()){
    console.log('[KIS] 저장된 토큰 유효, 만료:', new Date(_tokenExp).toLocaleTimeString('ko-KR'));
  } else {
    console.log('[KIS] 토큰 만료 — 페이지 로드 시 자동 재발급');
    KIS.getToken();
  }
}

})();
