/* ===========================================================================
 *  remind.js —— 每日复习提醒
 * ---------------------------------------------------------------------------
 *  纯前端、零后端，分两条路把人拉回来：
 *
 *  1) 应用内系统通知（window.Notification）
 *     · 应用/「添加到主屏幕」的 PWA 处于打开或后台挂着时，到设定时间弹一条
 *       系统通知；打开应用时若已过点、今天还没复习，也会补一条。
 *     · 浏览器完全关闭、且没有后端 Web Push 时，网页无法自己唤醒 —— 这条路
 *       天然做不到「关着也响」。所以再配第 2 条。
 *
 *  2) 导出每日重复日历（.ics）
 *     · 生成一个每天重复、自带闹钟(VALARM)的日历事件，导入平板/手机的系统
 *       「日历」后，由操作系统每天定点本地通知，关着网页、不联网也会响。
 *
 *  这个文件不依赖任何外部库；没有 Notification API（如 file:// 双击打开）时
 *  全部方法安全空转，绝不报错。
 * =========================================================================== */

window.Remind = (function () {
  'use strict';

  let timer = null;

  function S() { return window.Store ? window.Store.get() : null; }
  function settings() { const s = S(); return s ? s.settings : null; }
  function supported() { return typeof window.Notification !== 'undefined'; }
  function permission() { return supported() ? window.Notification.permission : 'unsupported'; }

  /* 等宽 'HH:MM' 字符串可直接比较先后 */
  function nowHM() {
    const d = new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
           '-' + String(d.getDate()).padStart(2, '0');
  }

  /* 今天还剩多少没完成（到期复习 + 今日可新学）。复习会话进行中时 status 仍可全局调用 */
  function pendingCount() {
    try {
      const r = window.Review && window.Review.status();
      return r ? (r.totalToday || 0) : 0;
    } catch (e) { return 0; }
  }

  function streakDays() {
    try {
      const s = S();
      return (s && window.Charts) ? window.Charts.streak(s.daily) : 0;
    } catch (e) { return 0; }
  }

  /* ---------------------------------------------------------------- 纯判定
     抽成无副作用纯函数，方便单测：到底该不该现在弹这一条。
     nowHM/remindHM 均为 'HH:MM'；lastDate/today 为 'YYYY-MM-DD'。 */
  function decide(nowHM, remindHM, lastDate, today, pending) {
    if (!remindHM) return false;
    if (nowHM < remindHM) return false;     // 还没到点
    if (lastDate === today) return false;   // 今天已经弹过
    if (!(pending > 0)) return false;       // 今天已清完，不打扰
    return true;
  }

  function buildBody() {
    const n = pendingCount();
    const streak = streakDays();
    let body = '今天还有 ' + n + ' 个单词要过，花几分钟清掉它。';
    if (streak > 0) body += '已连续打卡 ' + streak + ' 天，别让它断了。';
    return { title: '该背单词啦', body: body };
  }

  /* 真正弹一条系统通知。tag 相同会互相替换，不会堆一屏 */
  function show(title, body) {
    if (!supported() || window.Notification.permission !== 'granted') return false;
    let n = null;
    try {
      const icon = pickIcon();
      n = new window.Notification(title, {
        body: body, tag: 'kv-daily-remind', lang: 'zh-CN', icon: icon || undefined
      });
      n.onclick = function () {
        try { window.focus(); } catch (e) {}
        try { n.close(); } catch (e) {}
      };
      return true;
    } catch (e) { return false; }
  }

  function pickIcon() {
    try { return (location.protocol === 'http:' || location.protocol === 'https:')
      ? 'icons/icon-192.png' : ''; } catch (e) { return ''; }
  }

  /* 到点检查一次：满足条件就弹，并记下今天已弹 */
  function tick() {
    const s = settings();
    if (!s || !s.remindEnabled) return;
    if (!supported() || window.Notification.permission !== 'granted') return;
    const due = decide(nowHM(), s.remindTime || '20:00', s.remindLastDate, todayStr(), pendingCount());
    if (!due) return;
    const m = buildBody();
    if (show(m.title, m.body)) {
      s.remindLastDate = todayStr();
      if (window.Store) window.Store.save();
    }
  }

  /* 请求通知权限（必须在用户点击手势里调用） */
  function request(onDone) {
    if (!supported()) { if (onDone) onDone('unsupported'); return; }
    if (window.Notification.permission === 'granted') { if (onDone) onDone('granted'); return; }
    try {
      const p = window.Notification.requestPermission();
      if (p && typeof p.then === 'function') p.then(function (r) { if (onDone) onDone(r); });
      else if (onDone) onDone(window.Notification.permission);
    } catch (e) { if (onDone) onDone('denied'); }
  }

  /* 设置页「测试一下」：立即弹一条，不写 lastDate、不受时间限制 */
  function test(onDone) {
    request(function (perm) {
      if (perm !== 'granted') { if (onDone) onDone(perm || 'denied'); return; }
      const m = buildBody();
      const ok = show(m.title, pendingCount() > 0 ? m.body : '通知正常。到每日提醒时间且还有单词没背时，会这样提醒你。');
      if (onDone) onDone(ok ? 'granted' : 'failed');
    });
  }

  /* 应用启动时调用：对齐到每 30 秒检查一次，回到前台也补查 */
  function start() {
    if (timer) { clearInterval(timer); timer = null; }
    tick();   // 打开即补查（已过点且没复习会补一条）
    timer = setInterval(tick, 30 * 1000);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') tick();
    });
  }

  /* ------------------------------------------------------- 每日日历 .ics */

  function pad2(n) { return String(n).padStart(2, '0'); }

  /**
   * 生成每天重复、到点提醒的日历文件内容（floating 本地时间，跨时区按设备本地）。
   * @param {string} hm 'HH:MM'
   */
  function calendarICS(hm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hm || '20:00') || ['', '20', '00'];
    const hh = pad2(Number(m[1])), mm = m[2];
    // DTSTART 用今天日期拼一个起始时刻，RRULE 每天重复；事件长 10 分钟
    const d = new Date();
    const ymd = d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
    const start = ymd + 'T' + hh + mm + '00';
    const endD = new Date(d); endD.setMinutes(endD.getMinutes() + 10);
    const end = endD.getFullYear() + pad2(endD.getMonth() + 1) + pad2(endD.getDate()) +
                'T' + pad2(endD.getHours()) + pad2(endD.getMinutes()) + '00';
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    return [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//KaoyanVocab//Daily Reminder//CN',
      'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT',
      'UID:kv-daily-' + ymd + '@kaoyan-vocab',
      'DTSTAMP:' + stamp,
      'DTSTART:' + start,
      'DTEND:' + end,
      'RRULE:FREQ=DAILY',
      'SUMMARY:背单词 · 每日复习',
      'DESCRIPTION:今天的考研单词还没清，打开背单词应用过一遍，保持连续打卡。',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'DESCRIPTION:该背单词啦',
      'TRIGGER:PT0M',
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR',
      ''
    ].join('\r\n');
  }

  /* 触发浏览器下载 .ics（手法与备份导出一致） */
  function downloadCalendar(hm) {
    const text = calendarICS(hm);
    const blob = new Blob([text], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = '背单词每日提醒.ics';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  return {
    supported: supported, permission: permission, request: request,
    decide: decide, tick: tick, start: start, test: test,
    calendarICS: calendarICS, downloadCalendar: downloadCalendar,
    pendingCount: pendingCount
  };
})();
