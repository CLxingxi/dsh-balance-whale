/**
 * dsh-balance-whale — browser half.
 *
 * One floating whale in the frame-wide `shell.overlay` slot that watches the
 * DeepSeek account balance:
 *
 * - **Skins.** A picked skin (the user's chibi uploads, or the hand-drawn
 *   whale that ships inside this bundle) is fetched frame by frame from the
 *   host's asset route; the choice is remembered per browser.
 * - **Expressions.** `data-mood` drives both the frame and a small prop
 *   overlay: working (gear + typing dots), happy (heart + sparkles), worried
 *   (sweat drop), excited (confetti), sleep (zzz), error (red badge). The mood
 *   follows the Host's work state, balance moves, errors and drag gestures.
 * - **Bubbles.** A small speech bubble with a priority queue, tone colours and
 *   a pool of idle chatter.
 * - **Cute sounds.** A WebAudio kit synthesized in the browser: no audio
 *   assets, one mute toggle, unlocked by the first gesture.
 * - **Ledger.** Today's spend, the last turn's cost, this run's total, a
 *   seven-day chart and the recent balance changes, all attributed by the host.
 * - The odometer digits, drag-and-snap, edge flip and Q-bounce behaviour from
 *   the first version are unchanged.
 *
 * The bundle registers a lazy factory whose id equals the package name, per the
 * client-module contract; React comes from the browser module table. Nothing
 * outside React is required.
 *
 * @module dsh-balance-whale/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-balance-whale',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** Package id: bundle id, style marker and storage prefix. */
    const PLUGIN_ID = 'dsh-balance-whale'
    /** Host endpoints served by this package's own host half. */
    const STATE_URL = '/api/balance-whale/state'
    const SKINS_URL = '/api/balance-whale/skins'
    /** localStorage keys: layout and preferences are per browser. */
    const POS_KEY = PLUGIN_ID + '.position.v1'
    const HIDDEN_KEY = PLUGIN_ID + '.hidden.v1'
    const SKIN_KEY = PLUGIN_ID + '.skin.v1'
    const SOUND_KEY = PLUGIN_ID + '.sound.v1'
    /** Fallback whale box size until the host echoes its configured size. */
    const DEFAULT_SIZE = 96
    /** Gap kept between the widget and any screen edge, in px. */
    const EDGE_GAP = 10
    /** Release inside this distance of the bottom edge and the whale sits on it. */
    const BOTTOM_MAGNET = 132
    /** Pointer travel below this (px) still counts as a click, not a drag. */
    const CLICK_SLOP = 6
    /** Fallback poll interval until the host echoes its configured one. */
    const DEFAULT_REFRESH_SECONDS = 30
    /** Poll interval while the model is working, so the ledger stays sharp. */
    const WORK_REFRESH_SECONDS = 8
    /** Below this balance the whale starts worrying and says so. */
    const LOW_BALANCE = 5
    /** How long a finished turn keeps the whale happy. */
    const HAPPY_MS = 12_000
    /** Speech bubble pacing. */
    const BUBBLE_MS = 3000
    const BUBBLE_GAP_MS = 900
    const BUBBLE_QUEUE_LIMIT = 3
    /** Idle chatter cadence, in ms. */
    const CHATTER_MIN_MS = 240_000
    const CHATTER_SPAN_MS = 300_000

    /** Human labels for the tools the whale can announce. */
    const TOOL_LABELS = {
      read: '读文件', write: '写文件', edit: '改文件', glob: '找文件', grep: '搜代码',
      bash: '跑命令', job_output: '等任务', job_list: '看任务', web_search: '上网查',
      web_fetch: '抓网页', ask_user_question: '等你回答', todo_write: '列清单',
      subagent: '派小弟干活', workflow: '编排流程', present: '交付文件', skill: '翻技能书',
      task_board_create: '建任务卡', task_board_list: '看任务看板', cordis_inspect_query: '查接口',
      read_image: '看图', create_goal: '立目标', send_message: '传话', write_file: '写文件',
    }

    /** Idle chatter. The whale says one every few minutes, never more. */
    const IDLE_LINES = [
      '记得喝水哦～',
      '余额我帮你看着呢',
      '今天也要加油鸭！',
      '累了就休息一下吧',
      '要不要摸摸我的头？',
      '钱包安全，随时汇报～',
      '我一直在这里飘着～',
      '深呼吸，慢慢来就好',
    ]

    /**
     * Every style the widget owns, prefixed `bw-` so nothing collides with the
     * host's own classes. Containers and controls use the theme tokens the
     * Client theme service publishes; only the artwork keeps literal colours.
     */
    const CSS = `
.bw-root{position:fixed;left:0;top:0;z-index:30;pointer-events:auto;touch-action:none;
  -webkit-user-select:none;user-select:none;font-family:inherit;color:var(--dsw-alias-label-primary);
  will-change:transform;outline:none}
.bw-root:focus-visible .bw-stack{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:4px;border-radius:18px}
.bw-stack{display:flex;flex-direction:column;align-items:center;gap:2px;position:relative;cursor:grab}
.bw-root[data-dragging="1"] .bw-stack{cursor:grabbing}
.bw-flip{transition:transform .42s cubic-bezier(.22,1.35,.36,1);transform-origin:50% 60%}
.bw-spring{transform-origin:50% 68%;animation:bw-idle 3.6s ease-in-out infinite}
.bw-spring[data-boing="1"]{animation:bw-boing .62s cubic-bezier(.3,1.7,.4,1)}
.bw-spring[data-dragging="1"]{animation:none}
.bw-root[data-mood="working"] .bw-spring{animation-duration:1.25s}
.bw-root[data-mood="happy"] .bw-spring{animation:bw-happy 1.5s ease-in-out infinite}
.bw-root[data-mood="excited"] .bw-spring{animation:bw-boing .7s cubic-bezier(.3,1.6,.4,1) infinite}
.bw-root[data-mood="worried"] .bw-spring{animation:bw-shiver 2.4s ease-in-out infinite}
.bw-root[data-mood="sleep"] .bw-spring{animation:bw-sleep 5.4s ease-in-out infinite}
.bw-root[data-mood="error"] .bw-spring{animation:bw-shiver 1.6s ease-in-out infinite}
.bw-art{display:block;width:100%;height:100%;overflow:visible;filter:drop-shadow(0 8px 14px rgba(24,39,75,.22))}
.bw-face{display:block;width:100%;height:100%;object-fit:contain;-webkit-user-drag:none;
  filter:drop-shadow(0 8px 14px rgba(24,39,75,.26));transition:filter .3s ease}
.bw-root[data-mood="sleep"] .bw-face{filter:drop-shadow(0 8px 14px rgba(24,39,75,.2)) saturate(.72) brightness(.97)}
.bw-root[data-mood="error"] .bw-face{filter:drop-shadow(0 8px 14px rgba(24,39,75,.2)) saturate(.6)}
.bw-root[data-mood="happy"] .bw-face{filter:drop-shadow(0 8px 16px rgba(24,39,75,.24)) saturate(1.1) brightness(1.03)}
.bw-plate{position:absolute;inset:6%;border-radius:24%;background:var(--bw-plate);z-index:0}
.bw-art-inner{display:block;width:100%;height:100%;position:relative}
.bw-tail{transform-origin:28px 60px;animation:bw-wag 2.9s ease-in-out infinite}
.bw-whale-body{transform-origin:62px 72px;animation:bw-breathe 3.6s ease-in-out infinite}
.bw-drop{animation:bw-drop 2.7s ease-in-out infinite}
.bw-drop-2{animation-delay:.32s}
.bw-drop-3{animation-delay:.64s}
.bw-coin{opacity:0;transform-origin:104px 30px;transition:opacity .22s ease}
.bw-art-inner[data-busy="1"] .bw-coin{opacity:1;animation:bw-coin .95s ease-in-out infinite}
.bw-art-inner[data-busy="1"] .bw-drop{animation-duration:1.4s}
.bw-eyes-shut{display:none}
.bw-art-inner[data-sleepy="1"] .bw-eyes-open{display:none}
.bw-art-inner[data-sleepy="1"] .bw-eyes-shut{display:block}
.bw-art-inner[data-sleepy="1"] .bw-whale-body{animation-duration:5.4s}
.bw-ring{position:absolute;inset:-6%;border-radius:50%;pointer-events:none;opacity:0;transition:opacity .3s ease;
  border:2px dashed color-mix(in srgb, var(--bw-accent,#4D6BFE) 55%, transparent)}
.bw-root[data-mood="working"] .bw-ring{opacity:.9;animation:bw-spin 6s linear infinite}
.bw-props{position:absolute;right:-6px;top:-10px;width:46px;height:46px;pointer-events:none;
  filter:drop-shadow(0 3px 6px rgba(20,33,64,.28))}
.bw-prop-gear{transform-origin:32px 12px;animation:bw-spin 2.6s linear infinite}
.bw-prop-dots circle{animation:bw-dot 1.1s ease-in-out infinite}
.bw-prop-dots circle:nth-child(2){animation-delay:.16s}
.bw-prop-dots circle:nth-child(3){animation-delay:.32s}
.bw-prop-heart{transform-origin:22px 24px;animation:bw-beat 1.4s ease-in-out infinite}
.bw-prop-sparkle{transform-origin:22px 22px;animation:bw-twinkle 1.8s ease-in-out infinite}
.bw-prop-drop{transform-origin:20px 12px;animation:bw-sweat 2.2s ease-in-out infinite}
.bw-prop-z{animation:bw-z 3s ease-in-out infinite}
.bw-prop-z2{animation-delay:1s}
.bw-prop-z3{animation-delay:2s}
.bw-prop-star{transform-origin:22px 22px;animation:bw-twinkle 1.2s ease-in-out infinite}
.bw-pill{display:inline-flex;align-items:center;gap:3px;padding:4px 9px;border-radius:999px;
  background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);
  box-shadow:0 6px 16px rgba(24,39,75,.16);font-size:13px;font-weight:650;line-height:1;white-space:nowrap;
  transition:box-shadow .25s ease,border-color .25s ease,transform .25s cubic-bezier(.3,1.5,.4,1)}
.bw-root[data-flash="up"] .bw-pill{border-color:var(--dsw-alias-state-success-primary);
  box-shadow:0 6px 20px color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent)}
.bw-root[data-flash="down"] .bw-pill{border-color:var(--dsw-alias-state-warn-primary);
  box-shadow:0 6px 20px color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,transparent)}
.bw-root[data-mood="working"] .bw-pill{border-color:color-mix(in srgb,var(--bw-accent,#4D6BFE) 60%,var(--dsw-alias-border-l2))}
.bw-root[data-hover="1"] .bw-pill{transform:translateY(-1px)}
.bw-cur{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.bw-num{display:inline-flex;align-items:baseline;font-variant-numeric:tabular-nums;
  font-feature-settings:"tnum" 1;letter-spacing:0}
.bw-digit{display:inline-block;height:1em;line-height:1;overflow:hidden;width:.56em;text-align:center}
.bw-strip{display:flex;flex-direction:column;transition:transform .9s cubic-bezier(.2,1.3,.3,1)}
.bw-strip>span{display:block;height:1em;line-height:1;text-align:center}
.bw-static{display:inline-block;height:1em;line-height:1;opacity:.72}
.bw-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:none}
.bw-root[data-mode="loading"] .bw-dot,.bw-root[data-mode="error"] .bw-dot{background:var(--dsw-alias-state-warn-primary)}
.bw-root[data-mode="signed-out"] .bw-dot{background:var(--dsw-alias-state-idle-primary)}
.bw-root[data-mood="working"] .bw-dot{background:var(--bw-accent,#4D6BFE);animation:bw-blink 1.2s ease-in-out infinite}
.bw-bubble{position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%) translateY(4px);
  max-width:210px;padding:5px 10px;border-radius:12px;background:var(--dsw-alias-bg-overlay);
  border:1px solid var(--dsw-alias-border-l2);box-shadow:0 8px 20px rgba(24,39,75,.18);
  font-size:12px;line-height:1.35;color:var(--dsw-alias-label-primary);text-align:center;
  opacity:0;pointer-events:none;transition:opacity .22s ease,transform .3s cubic-bezier(.3,1.5,.4,1);white-space:normal}
.bw-root[data-bubble="1"] .bw-bubble{opacity:1;transform:translateX(-50%) translateY(0)}
.bw-bubble[data-tone="happy"]{border-color:var(--dsw-alias-state-success-primary)}
.bw-bubble[data-tone="warn"]{border-color:var(--dsw-alias-state-warn-primary)}
.bw-bubble[data-tone="error"]{border-color:var(--dsw-alias-state-error-primary)}
.bw-bubble[data-tone="work"]{border-color:var(--bw-accent,#4D6BFE)}
.bw-bubble:after{content:"";position:absolute;top:100%;left:50%;width:8px;height:8px;margin-left:-4px;
  background:var(--dsw-alias-bg-overlay);border-right:1px solid var(--dsw-alias-border-l2);
  border-bottom:1px solid var(--dsw-alias-border-l2);transform:rotate(45deg) translateY(-5px)}
.bw-card{position:absolute;width:250px;box-sizing:border-box;padding:11px 12px 10px;border-radius:14px;
  background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);
  box-shadow:0 16px 34px rgba(20,33,64,.24);font-size:12px;line-height:1.45;
  color:var(--dsw-alias-label-secondary);display:flex;flex-direction:column;gap:8px;cursor:default;
  max-height:64vh;overflow-y:auto;overscroll-behavior:contain}
.bw-card-title{display:flex;align-items:center;justify-content:space-between;gap:8px;
  color:var(--dsw-alias-label-primary);font-size:12px;font-weight:650}
.bw-hero{display:flex;align-items:baseline;gap:6px;color:var(--dsw-alias-label-primary)}
.bw-hero .bw-num{font-size:25px;font-weight:700}
.bw-hero .bw-cur{font-size:13px;font-weight:650;color:var(--dsw-alias-label-secondary)}
.bw-card-row{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
.bw-card-row b{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:650}
.bw-sec{display:flex;flex-direction:column;gap:5px}
.bw-sec-title{display:flex;align-items:center;justify-content:space-between;font-size:11px;font-weight:650;
  color:var(--dsw-alias-label-primary);opacity:.9}
.bw-card-sep{height:1px;background:var(--dsw-alias-border-l1);margin:1px 0}
.bw-bars{display:flex;align-items:flex-end;gap:3px;height:34px;padding:2px 0}
.bw-bar{flex:1;min-height:2px;border-radius:3px 3px 2px 2px;
  background:color-mix(in srgb,var(--bw-accent,#4D6BFE) 55%,transparent);transition:height .4s ease}
.bw-bar-today{background:var(--bw-accent,#4D6BFE)}
.bw-bar-wrap{flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:100%;gap:2px}
.bw-bar-label{font-size:9px;text-align:center;opacity:.65;line-height:1}
.bw-recent{display:flex;flex-direction:column;gap:3px;font-size:11px}
.bw-recent-row{display:flex;justify-content:space-between;gap:8px}
.bw-delta-up{color:var(--dsw-alias-state-success-primary)}
.bw-delta-down{color:var(--dsw-alias-state-warn-primary)}
.bw-actions{display:flex;gap:6px;flex-wrap:wrap}
.bw-btn{appearance:none;font:inherit;font-size:12px;line-height:1;padding:5px 9px;border-radius:9px;cursor:pointer;
  color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l2);text-decoration:none;display:inline-flex;align-items:center;gap:4px;
  transition:border-color .16s ease,background .16s ease,transform .16s ease}
.bw-btn:hover{border-color:var(--dsw-alias-brand-primary);transform:translateY(-1px)}
.bw-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.bw-btn-on{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1)}
.bw-skins{display:grid;grid-template-columns:repeat(auto-fill,minmax(38px,1fr));gap:6px}
.bw-skin{appearance:none;padding:2px;border-radius:11px;cursor:pointer;background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l2);display:flex;align-items:center;justify-content:center;
  aspect-ratio:1;transition:transform .16s ease,border-color .16s ease}
.bw-skin:hover{transform:translateY(-2px);border-color:var(--dsw-alias-brand-primary)}
.bw-skin-active{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary) inset}
.bw-skin img,.bw-skin svg{width:100%;height:100%;object-fit:contain;display:block}
.bw-thumb{display:block;width:100%;height:100%}
.bw-thumb svg,.bw-thumb img{width:100%;height:100%;object-fit:contain;display:block}
.bw-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));opacity:.85}
.bw-restore{display:inline-flex;align-items:center;gap:6px;padding:5px 10px 5px 6px;border-radius:999px;
  background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);
  box-shadow:0 6px 16px rgba(24,39,75,.16);font-size:12px;font-weight:600;cursor:pointer;color:var(--dsw-alias-label-primary)}
.bw-restore:hover{border-color:var(--dsw-alias-brand-primary)}
.bw-restore-art{width:22px;height:22px;display:block}
.bw-restore-art img,.bw-restore-art svg{width:100%;height:100%;object-fit:contain;display:block}
@keyframes bw-idle{0%,100%{transform:scale(1,1)}50%{transform:scale(1.045,.955)}}
@keyframes bw-happy{0%,100%{transform:scale(1,1) rotate(0)}25%{transform:scale(1.06,.94) rotate(-2.5deg)}
  60%{transform:scale(.97,1.04) rotate(2.5deg)}}
@keyframes bw-shiver{0%,100%{transform:translateX(0) rotate(0)}20%{transform:translateX(-1.5px) rotate(-1.2deg)}
  45%{transform:translateX(1.5px) rotate(1.2deg)}70%{transform:translateX(-1px) rotate(-.6deg)}}
@keyframes bw-sleep{0%,100%{transform:scale(1,1) rotate(-1.5deg)}50%{transform:scale(1.03,.97) rotate(-1.5deg)}}
@keyframes bw-breathe{0%,100%{transform:scale(1,1)}50%{transform:scale(1.025,.975)}}
@keyframes bw-wag{0%,72%,100%{transform:rotate(0deg)}82%{transform:rotate(-11deg)}92%{transform:rotate(7deg)}}
@keyframes bw-drop{0%{opacity:0;transform:translateY(4px) scale(.7)}35%{opacity:1}100%{opacity:0;transform:translateY(-9px) scale(1.05)}}
@keyframes bw-coin{0%,100%{transform:translateY(0) rotate(-8deg)}50%{transform:translateY(-4px) rotate(8deg)}}
@keyframes bw-boing{0%{transform:scale(1,1)}22%{transform:scale(1.17,.83)}46%{transform:scale(.9,1.13)}70%{transform:scale(1.06,.95)}100%{transform:scale(1,1)}}
@keyframes bw-spin{to{transform:rotate(360deg)}}
@keyframes bw-dot{0%,100%{opacity:.35;transform:translateY(0)}50%{opacity:1;transform:translateY(-2px)}}
@keyframes bw-beat{0%,100%{transform:scale(1)}35%{transform:scale(1.18)}60%{transform:scale(.96)}}
@keyframes bw-twinkle{0%,100%{opacity:.35;transform:scale(.85) rotate(0)}50%{opacity:1;transform:scale(1.1) rotate(20deg)}}
@keyframes bw-sweat{0%{opacity:0;transform:translateY(-3px) scale(.6)}30%{opacity:1}100%{opacity:0;transform:translateY(9px) scale(1)}}
@keyframes bw-z{0%{opacity:0;transform:translate(0,4px) scale(.7)}30%{opacity:1}100%{opacity:0;transform:translate(6px,-8px) scale(1.15)}}
@keyframes bw-blink{0%,100%{opacity:1}50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){
  .bw-spring,.bw-whale-body,.bw-tail,.bw-drop,.bw-ring,.bw-prop-gear,.bw-prop-dots circle,.bw-prop-heart,
  .bw-prop-sparkle,.bw-prop-drop,.bw-prop-z,.bw-prop-star,.bw-dot{animation:none}
  .bw-digit .bw-strip{transition:none}
  .bw-flip{transition:none}
}
`

    /** The hand-drawn skin: a chibi DeepSeek-blue whale with a spout and a coin. */
    const WHALE_SVG = `<svg class="bw-art" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="bwGradBody" x1="0.15" y1="0" x2="0.85" y2="1">
      <stop offset="0" stop-color="#93B7FF"/><stop offset="0.45" stop-color="#5B7BFF"/><stop offset="1" stop-color="#2C42C2"/>
    </linearGradient>
    <linearGradient id="bwGradBelly" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.97"/><stop offset="1" stop-color="#D3E1FF" stop-opacity="0.93"/>
    </linearGradient>
    <radialGradient id="bwGradGlow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#9CC0FF" stop-opacity="0.42"/><stop offset="1" stop-color="#9CC0FF" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <ellipse class="bw-glow" cx="60" cy="92" rx="46" ry="20" fill="url(#bwGradGlow)"/>
  <g class="bw-whale-body">
    <path class="bw-tail" d="M28 68c-10-2-19-10-20-19-1-8 5-14 11-12 5 1 8 6 10 12 2 7 3 13-1 19z" fill="url(#bwGradBody)"/>
    <path class="bw-tail" d="M28 68c-11 5-23 4-29-2-4-4-4-11 1-13 5-2 11 1 15 5 4 4 8 8 13 10z" fill="#3B54D6"/>
    <ellipse class="bw-fin bw-fin-left" cx="36" cy="90" rx="14" ry="8.4" transform="rotate(-22 36 90)" fill="#3A52CE"/>
    <ellipse class="bw-fin bw-fin-right" cx="90" cy="86" rx="13" ry="7.8" transform="rotate(16 90 86)" fill="#6C89FF"/>
    <path d="M62 26c27 0 46 19 46 42 0 24-20 39-46 39S16 92 16 68c0-23 19-42 46-42z" fill="url(#bwGradBody)"/>
    <path d="M62 104c-19 0-34-12-37-29 9-10 22-15 37-15s28 5 37 15c-3 17-18 29-37 29z" fill="url(#bwGradBelly)"/>
    <path d="M40 96h44M45 102h34" stroke="#B4C8FF" stroke-width="2.2" stroke-linecap="round" fill="none" opacity="0.72"/>
    <g class="bw-eyes bw-eyes-open">
      <ellipse cx="47" cy="60" rx="6.6" ry="7.6" fill="#16203F"/>
      <ellipse cx="77" cy="60" rx="6.6" ry="7.6" fill="#16203F"/>
      <circle cx="49.6" cy="56.6" r="2.5" fill="#FFFFFF"/>
      <circle cx="79.6" cy="56.6" r="2.5" fill="#FFFFFF"/>
      <circle cx="45" cy="63.8" r="1.15" fill="#FFFFFF" opacity="0.85"/>
      <circle cx="75" cy="63.8" r="1.15" fill="#FFFFFF" opacity="0.85"/>
    </g>
    <g class="bw-eyes bw-eyes-shut">
      <path d="M41 62q6-7 12 0" stroke="#16203F" stroke-width="2.8" fill="none" stroke-linecap="round"/>
      <path d="M71 62q6-7 12 0" stroke="#16203F" stroke-width="2.8" fill="none" stroke-linecap="round"/>
    </g>
    <ellipse class="bw-blush" cx="34" cy="72" rx="6" ry="3.4" fill="#FF9DB8" opacity="0.5"/>
    <ellipse class="bw-blush" cx="90" cy="72" rx="6" ry="3.4" fill="#FF9DB8" opacity="0.5"/>
    <path d="M56 72q6 7 12 0" stroke="#16203F" stroke-width="2.4" fill="none" stroke-linecap="round"/>
    <g class="bw-spout">
      <path d="M64 26c-1-6 2-10 8-12" stroke="#9CC0FF" stroke-width="2.6" fill="none" stroke-linecap="round" opacity="0.85"/>
      <circle class="bw-drop bw-drop-1" cx="73" cy="11" r="3" fill="#A8C8FF"/>
      <circle class="bw-drop bw-drop-2" cx="66" cy="5" r="2.2" fill="#C3D9FF"/>
      <circle class="bw-drop bw-drop-3" cx="79" cy="4" r="1.7" fill="#D8E6FF"/>
    </g>
    <g class="bw-coin">
      <circle cx="104" cy="30" r="13" fill="#FFC94D" stroke="#F0A800" stroke-width="2"/>
      <text x="104" y="36" text-anchor="middle" font-size="15" font-weight="700" fill="#8A5200"
        font-family="system-ui,-apple-system,Segoe UI,sans-serif">{SYM}</text>
    </g>
  </g>
</svg>`

    /**
     * Mood props: a small overlay drawn above the art. Each entry is its own
     * SVG so a skin change or a mood change never has to re-derive artwork.
     */
    const MOOD_PROPS = {
      working: `<svg viewBox="0 0 46 46" aria-hidden="true"><g class="bw-prop-gear" transform="translate(30,12)">
  <circle r="9" fill="none" stroke="#7FA0FF" stroke-width="3" stroke-dasharray="4 3"/><circle r="3.4" fill="#7FA0FF"/></g>
  <g class="bw-prop-dots" transform="translate(8,34)"><circle cx="0" r="2.6" fill="#9CC0FF"/>
  <circle cx="9" r="2.6" fill="#9CC0FF"/><circle cx="18" r="2.6" fill="#9CC0FF"/></g></svg>`,
      happy: `<svg viewBox="0 0 46 46" aria-hidden="true">
  <path class="bw-prop-heart" d="M20 36c-8-6-12-10-12-15a6 6 0 0 1 12-3 6 6 0 0 1 12 3c0 5-4 9-12 15z" fill="#FF7EA8"/>
  <g class="bw-prop-sparkle" transform="translate(34,12)"><path d="M0-6 L2 0 8 2 2 4 0 10-2 4-8 2-2 0z" fill="#FFD35C"/></g>
  <g class="bw-prop-sparkle" transform="translate(8,16)" style="animation-delay:.5s">
    <path d="M0-4 L1.4 0 5 1.4 1.4 2.8 0 7-1.4 2.8-5 1.4-1.4 0z" fill="#9FE1FF"/></g></svg>`,
      worried: `<svg viewBox="0 0 46 46" aria-hidden="true">
  <path class="bw-prop-drop" d="M18 8c4 6 7 9 7 13a7 7 0 0 1-14 0c0-4 3-7 7-13z" fill="#9FD8FF"/>
  <circle cx="33" cy="30" r="9" fill="#FFD35C"/><rect x="32" y="24" width="2.6" height="8" rx="1.3" fill="#7A4A00"/>
  <circle cx="33.3" cy="35" r="1.6" fill="#7A4A00"/></svg>`,
      excited: `<svg viewBox="0 0 46 46" aria-hidden="true">
  <g class="bw-prop-star" transform="translate(22,20)"><path d="M0-11 L2.6 0 13 2 2.6 4 0 15-2.6 4-13 2-2.6 0z" fill="#FFD35C"/></g>
  <circle cx="6" cy="10" r="2.4" fill="#FF9DB8"/><circle cx="40" cy="14" r="2" fill="#9FE1FF"/>
  <circle cx="10" cy="38" r="2" fill="#C3D9FF"/><circle cx="38" cy="36" r="2.6" fill="#FFC94D"/></svg>`,
      sleep: `<svg viewBox="0 0 46 46" aria-hidden="true">
  <text class="bw-prop-z" x="8" y="30" font-size="13" font-weight="700" fill="#9CC0FF" font-family="system-ui,sans-serif">z</text>
  <text class="bw-prop-z bw-prop-z2" x="20" y="22" font-size="16" font-weight="700" fill="#A8C8FF" font-family="system-ui,sans-serif">z</text>
  <text class="bw-prop-z bw-prop-z3" x="33" y="12" font-size="19" font-weight="700" fill="#C3D9FF" font-family="system-ui,sans-serif">Z</text></svg>`,
      error: `<svg viewBox="0 0 46 46" aria-hidden="true">
  <circle cx="23" cy="23" r="15" fill="#FF6B6B"/><rect x="21.4" y="13" width="3.2" height="14" rx="1.6" fill="#FFFFFF"/>
  <circle cx="23" cy="32" r="2.1" fill="#FFFFFF"/></svg>`,
    }

    // -----------------------------------------------------------------------
    // Small helpers

    /** Viewport size, guarded for a jsdom-less environment. */
    function viewport() {
      return {
        w: typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1280,
        h: typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 800,
      }
    }

    /** Clamp a number into a range. */
    function clamp(value, min, max) {
      if (max < min) return min
      return Math.min(max, Math.max(min, value))
    }

    /** The currency glyph the amount is shown with. */
    function currencySymbol(currency) {
      return currency === 'USD' ? '$' : '¥'
    }

    /** Group a numeric string as `1,234.56`, keeping two decimals. */
    function formatAmount(raw) {
      const number = Number(raw)
      if (!Number.isFinite(number)) return String(raw ?? '0.00')
      const fixed = Math.abs(number).toFixed(2)
      const parts = fixed.split('.')
      return parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + parts[1]
    }

    /** Two-decimal amount with an explicit sign, for deltas. */
    function formatDelta(raw) {
      const number = Number(raw)
      if (!Number.isFinite(number) || number === 0) return '0.00'
      return (number > 0 ? '+' : '−') + Math.abs(number).toFixed(2)
    }

    /** A compact "3 分钟前" for a timestamp. */
    function timeAgo(at) {
      if (!Number.isFinite(at) || at <= 0) return '—'
      const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
      if (seconds < 60) return seconds + ' 秒前'
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return minutes + ' 分钟前'
      const hours = Math.round(minutes / 60)
      if (hours < 24) return hours + ' 小时前'
      return Math.round(hours / 24) + ' 天前'
    }

    /** `HH:MM` for a timestamp. */
    function clockTime(at) {
      if (!Number.isFinite(at) || at <= 0) return '—'
      return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }

    /** Read one persisted string preference. */
    function loadString(key) {
      try {
        return window.localStorage.getItem(key)
      } catch {
        return null
      }
    }

    /** Persist one string preference; storage failures never break the widget. */
    function saveString(key, value) {
      try {
        window.localStorage.setItem(key, value)
      } catch {
        /* private mode or a full quota */
      }
    }

    /** Where the whale sits before the user ever drags it: the bottom-right corner. */
    function defaultPosition(size) {
      const { w, h } = viewport()
      return { x: Math.max(EDGE_GAP, w - size - 24), y: Math.max(EDGE_GAP, h - size - 76), edge: 'right' }
    }

    /** Read the persisted layout, when it still fits the current viewport. */
    function loadPosition(size) {
      try {
        const raw = window.localStorage.getItem(POS_KEY)
        if (raw === null) return null
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') return null
        const x = Number(parsed.x)
        const y = Number(parsed.y)
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null
        const { w, h } = viewport()
        if (x > w - 24 || y > h - 24 || x < -size || y < -size) return null
        return { x, y, edge: parsed.edge === 'left' ? 'left' : 'right' }
      } catch {
        return null
      }
    }

    /** Persist the layout. */
    function savePosition(position) {
      try {
        window.localStorage.setItem(POS_KEY, JSON.stringify(position))
      } catch {
        /* see saveString */
      }
    }

    /** The tool name as a short human phrase. */
    function toolLabel(tool) {
      if (typeof tool !== 'string' || tool === '') return '忙活'
      return TOOL_LABELS[tool] ?? tool
    }

    /** Fetch JSON with a clear error for a non-2xx answer. */
    async function fetchJson(url) {
      const response = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      return response.json()
    }

    // -----------------------------------------------------------------------
    // Cute sounds: a tiny WebAudio kit, no audio assets

    /**
     * A handful of synthesized blips. The AudioContext is created lazily on the
     * first user gesture (browsers refuse to start audio before one) and every
     * call is wrapped so a missing or blocked audio stack is silent, never fatal.
     *
     * @returns {object} The kit: `unlock`, one method per effect, `setEnabled`.
     */
    function createSoundKit() {
      let context = null
      let enabled = true

      /** Lazily create/resume the audio context. */
      function audio() {
        if (typeof window === 'undefined') return null
        const Ctor = window.AudioContext ?? window.webkitAudioContext
        if (Ctor === undefined) return null
        try {
          if (context === null) context = new Ctor()
          if (context.state === 'suspended') context.resume().catch(() => {})
          return context
        } catch {
          return null
        }
      }

      /**
       * One enveloped oscillator sweep.
       *
       * @param {object} spec - Frequency ramp, duration, level and waveform.
       */
      function tone(spec) {
        if (!enabled) return
        const ctx = audio()
        if (ctx === null) return
        const start = ctx.currentTime + (spec.delay ?? 0)
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = spec.type ?? 'sine'
        osc.frequency.setValueAtTime(spec.freq, start)
        if (spec.to !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(30, spec.to), start + spec.dur)
        const level = spec.gain ?? 0.05
        gain.gain.setValueAtTime(0.0001, start)
        gain.gain.exponentialRampToValueAtTime(level, start + 0.012)
        gain.gain.exponentialRampToValueAtTime(0.0001, start + spec.dur)
        osc.connect(gain).connect(ctx.destination)
        osc.start(start)
        osc.stop(start + spec.dur + 0.02)
      }

      return {
        unlock() {
          audio()
        },
        setEnabled(next) {
          enabled = next
        },
        /** Grab: a tiny tick. */
        tick() {
          tone({ freq: 1180, to: 1500, dur: 0.05, gain: 0.025, type: 'triangle' })
        },
        /** Tap: a soft pop. */
        pop() {
          tone({ freq: 620, to: 1020, dur: 0.09, gain: 0.045 })
        },
        /** Snap: a rubbery boing. */
        boing() {
          tone({ freq: 300, to: 120, dur: 0.2, gain: 0.06, type: 'triangle' })
          tone({ freq: 520, to: 240, dur: 0.16, gain: 0.03, delay: 0.02, type: 'sine' })
        },
        /** Money up: two bright notes. */
        coin() {
          tone({ freq: 988, dur: 0.1, gain: 0.05 })
          tone({ freq: 1319, dur: 0.16, gain: 0.045, delay: 0.08 })
        },
        /** A turn settled: a gentle descending pair. */
        chime() {
          tone({ freq: 880, dur: 0.14, gain: 0.04 })
          tone({ freq: 659, dur: 0.22, gain: 0.035, delay: 0.11 })
        },
        /** Work started: a soft rising blip. */
        blip() {
          tone({ freq: 520, to: 780, dur: 0.12, gain: 0.03, type: 'sine' })
        },
        /** Something is wrong: two low notes. */
        warn() {
          tone({ freq: 420, dur: 0.14, gain: 0.045, type: 'square' })
          tone({ freq: 300, dur: 0.22, gain: 0.04, delay: 0.13, type: 'square' })
        },
        /** A friendly greeting. */
        hello() {
          tone({ freq: 659, dur: 0.1, gain: 0.04 })
          tone({ freq: 784, dur: 0.1, gain: 0.04, delay: 0.09 })
          tone({ freq: 1046, dur: 0.18, gain: 0.035, delay: 0.18 })
        },
      }
    }

    // -----------------------------------------------------------------------
    // Presentational pieces

    /**
     * An odometer number: one rolling strip per digit, static glyphs for the
     * separators. Digits keep their positional identity, so a changed value
     * rolls only the strips that differ from the previous render.
     */
    function RollingDigits(props) {
      const text = String(props.value ?? '')
      const children = []
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index]
        if (char >= '0' && char <= '9') {
          const strip = []
          for (let digit = 0; digit <= 9; digit += 1) strip.push(h('span', { key: digit }, String(digit)))
          children.push(h('span', { className: 'bw-digit', key: 'd' + index },
            h('span', { className: 'bw-strip', style: { transform: 'translateY(' + (-Number(char)) + 'em)' } }, strip)))
        } else {
          children.push(h('span', { className: 'bw-static', key: 's' + index }, char))
        }
      }
      return h('span', { className: props.className ?? 'bw-num' }, children)
    }

    /**
     * The whale picture for one skin: the inline drawing for the built-in skin,
     * or the host-served frame for an image skin.
     */
    function SkinArt(props) {
      const skin = props.skin
      const markup = useMemo(
        () => WHALE_SVG.replace('{SYM}', () => currencySymbol(props.currency)),
        [props.currency],
      )
      if (skin === undefined || skin.builtin === true) {
        return h('div', {
          className: 'bw-art-inner',
          'data-busy': props.busy ? '1' : '0',
          'data-sleepy': props.sleepy ? '1' : '0',
          dangerouslySetInnerHTML: { __html: markup },
        })
      }
      const url = props.frameUrl
      return h('div', { className: 'bw-art-inner', 'data-busy': props.busy ? '1' : '0' },
        skin.plate === null || skin.plate === undefined
          ? null
          : h('span', { className: 'bw-plate', style: { '--bw-plate': skin.plate } }),
        url === undefined
          ? h('div', { className: 'bw-face' })
          : h('img', { className: 'bw-face', src: url, alt: '', draggable: false }))
    }

    /** The mood's prop overlay, when that mood has one. */
    function MoodProps(props) {
      const markup = MOOD_PROPS[props.mood]
      if (markup === undefined) return null
      return h('div', {
        className: 'bw-props',
        key: props.mood,
        dangerouslySetInnerHTML: { __html: markup },
      })
    }

    /** The seven-day spend chart. */
    function SpendChart(props) {
      const days = Array.isArray(props.days) ? props.days : []
      const max = days.reduce((peak, day) => Math.max(peak, Number(day.spent) || 0), 0)
      return h('div', { className: 'bw-bars' }, days.map((day) => {
        const spent = Number(day.spent) || 0
        const height = max <= 0 ? 2 : Math.max(2, Math.round((spent / max) * 30))
        const today = props.today === day.date
        return h('div', {
          className: 'bw-bar-wrap',
          key: day.date,
          title: day.date + ' 已用 ' + currencySymbol(props.currency) + spent.toFixed(2),
        },
        h('span', {
          className: 'bw-bar' + (today ? ' bw-bar-today' : ''),
          style: { height: height + 'px' },
        }),
        h('span', { className: 'bw-bar-label' }, day.label.slice(3)))
      }))
    }

    // -----------------------------------------------------------------------
    // The widget

    /**
     * The widget itself: layout, drag/snap/flip physics, polling, moods,
     * bubbles, sounds, the skin picker and the ledger panel.
     */
    function BalanceWhale() {
      const [hidden, setHidden] = useState(() => loadString(HIDDEN_KEY) === '1')
      const [size, setSize] = useState(DEFAULT_SIZE)
      const [position, setPosition] = useState(() => loadPosition(DEFAULT_SIZE) ?? defaultPosition(DEFAULT_SIZE))
      const [dragging, setDragging] = useState(false)
      const [tilt, setTilt] = useState(0)
      const [hover, setHover] = useState(false)
      const [pinned, setPinned] = useState(false)
      const [boing, setBoing] = useState(false)
      const [busy, setBusy] = useState(false)
      const [flash, setFlash] = useState('')
      const [bubble, setBubble] = useState(null)
      const [snapshot, setSnapshot] = useState({ phase: 'loading', data: null, error: null })
      const [skins, setSkins] = useState([])
      const [skinId, setSkinId] = useState(() => loadString(SKIN_KEY))
      const [soundOn, setSoundOn] = useState(() => loadString(SOUND_KEY) !== '0')
      const [skinsOpen, setSkinsOpen] = useState(false)
      const [happyUntil, setHappyUntil] = useState(0)

      const rootRef = useRef(null)
      const dragRef = useRef(null)
      const positionRef = useRef(position)
      const sizeRef = useRef(size)
      const amountRef = useRef(null)
      const phaseRef = useRef(null)
      const turnRef = useRef(null)
      const lowRef = useRef(null)
      const signedOutRef = useRef(false)
      const errorRef = useRef(null)
      const aliveRef = useRef(true)
      const timersRef = useRef([])
      const bubbleRef = useRef({ current: null, queue: [], lastAt: 0 })
      const soundRef = useRef(null)
      const chatterRef = useRef(0)
      positionRef.current = position
      sizeRef.current = size

      if (soundRef.current === null) soundRef.current = createSoundKit()
      const sound = soundRef.current

      const data = snapshot.data
      const activity = data?.activity ?? null
      const phase = activity?.phase ?? 'idle'
      const mode = snapshot.phase === 'loading' && data === null
        ? 'loading'
        : data !== null && data.signedIn === false
          ? 'signed-out'
          : snapshot.error !== null && (data === null || data.ok !== true)
            ? 'error'
            : 'ready'
      const totals = Array.isArray(data?.totals) ? data.totals : []
      const primary = totals[0] ?? null
      const currency = primary?.currency ?? 'CNY'
      const amount = formatAmount(primary?.total ?? '0.00')
      const ledger = data?.ledger ?? null
      const symbol = currencySymbol(currency)
      const baseSeconds = typeof data?.refreshSeconds === 'number' && data.refreshSeconds > 0
        ? data.refreshSeconds
        : DEFAULT_REFRESH_SECONDS
      const pollSeconds = phase === 'working' ? Math.min(baseSeconds, WORK_REFRESH_SECONDS) : baseSeconds
      const total = Number(primary?.total ?? 0)
      const low = data !== null && data.signedIn === true && Number.isFinite(total) && total < LOW_BALANCE

      useEffect(() => {
        if (typeof data?.size === 'number' && data.size > 0) setSize(data.size)
      }, [data])

      // The host's skin summary (id list) is compared by membership, never by
      // position or length: a fetched registry has frame URLs and may legitimately
      // be longer, and comparing those would refetch on every render.
      useEffect(() => {
        const listed = Array.isArray(data?.skins) ? data.skins : []
        if (listed.length === 0) return
        const missing = skins.length === 0 || listed.some((skin) => !skins.some((loaded) => loaded.id === skin.id))
        if (!missing) return
        fetchJson(SKINS_URL).then((body) => {
          if (!aliveRef.current) return
          const next = Array.isArray(body.skins) ? body.skins : []
          setSkins(next)
          setSkinId((current) => {
            if (typeof current === 'string' && next.some((skin) => skin.id === current)) return current
            return body.defaultSkin ?? next[0]?.id ?? null
          })
        }, () => {})
      }, [data, skins])

      /** Run one callback after a delay, tracked so unmount clears it. */
      const later = useCallback((fn, ms) => {
        const id = window.setTimeout(() => {
          timersRef.current = timersRef.current.filter((timer) => timer !== id)
          fn()
        }, ms)
        timersRef.current.push(id)
        return id
      }, [])

      useEffect(() => () => {
        aliveRef.current = false
        for (const timer of timersRef.current) window.clearTimeout(timer)
      }, [])

      /**
       * Queue a speech bubble. A bubble already on screen is never cut off by a
       * low-priority line; the queue is short and drops the oldest extra.
       *
       * @param {string} text - What the whale says.
       * @param {string} [tone] - `info` | `happy` | `warn` | `error` | `work`.
       */
      const speak = useCallback((text, tone = 'info') => {
        const state = bubbleRef.current
        if (state.current !== null) {
          state.queue.push({ text, tone })
          if (state.queue.length > BUBBLE_QUEUE_LIMIT) state.queue.shift()
          return
        }
        state.current = { text, tone }
        setBubble({ text, tone })
        later(() => {
          state.current = null
          setBubble(null)
          const next = state.queue.shift()
          if (next !== undefined) later(() => speak(next.text, next.tone), BUBBLE_GAP_MS)
        }, BUBBLE_MS)
      }, [later])

      /** Read the host's balance endpoint; `force` bypasses its short cache. */
      const refresh = useCallback(async (force) => {
        setBusy(true)
        try {
          const body = await fetchJson(STATE_URL + (force ? '?refresh=1' : ''))
          if (!aliveRef.current) return
          setSnapshot({ phase: 'ready', data: body, error: body.ok === false ? String(body.error ?? 'failed') : null })
        } catch (error) {
          if (!aliveRef.current) return
          setSnapshot((previous) => ({
            phase: 'ready',
            data: previous.data,
            error: error instanceof Error ? error.message : String(error),
          }))
        } finally {
          if (aliveRef.current) setBusy(false)
        }
      }, [])

      // Initial read plus the background poll; a refocused page refreshes too.
      useEffect(() => {
        refresh(false)
        const interval = window.setInterval(() => refresh(false), Math.max(5, pollSeconds) * 1000)
        const onVisibility = () => {
          if (document.visibilityState === 'visible') refresh(false)
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          window.clearInterval(interval)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [refresh, pollSeconds])

      // Work-state, balance and mood transitions, which drive expressions,
      // bubbles and sounds.
      useEffect(() => {
        if (data === null) return
        const previousAmount = amountRef.current
        const previousPhase = phaseRef.current
        const previousTurn = turnRef.current
        const nextAmount = data.signedIn === true ? Number(primary?.total ?? NaN) : NaN
        amountRef.current = Number.isFinite(nextAmount) ? nextAmount : null
        phaseRef.current = phase
        turnRef.current = ledger?.lastTurn?.at ?? null

        if (previousPhase !== null && previousPhase !== phase) {
          if (phase === 'working') {
            sound.blip()
            speak('开工啦，' + toolLabel(activity?.tool) + '中…', 'work')
          } else if (previousPhase === 'working' && data.signedIn === true) {
            // Money chatter needs a signed-in balance to talk about.
            const delta = Number(ledger?.lastTurn?.delta ?? 0)
            if (delta > 0) {
              setHappyUntil(Date.now() + HAPPY_MS)
              later(() => setHappyUntil(0), HAPPY_MS + 60)
              sound.chime()
              speak('这轮花了 ' + symbol + delta.toFixed(2) + '，余额 ' + symbol + amount, 'info')
            } else {
              speak('搞定啦～余额 ' + symbol + amount, 'happy')
            }
          }
        }

        // Each notice is edge-triggered, so a poll that repeats the same state
        // never repeats the bubble or the sound.
        const signedOut = data.signedIn === false
        if (signedOut && signedOutRef.current === false) {
          speak('登录 DeepSeek 账号就能看到余额啦', 'warn')
        }
        signedOutRef.current = signedOut

        if (Number.isFinite(nextAmount) && previousAmount !== null && nextAmount !== previousAmount) {
          if (nextAmount > previousAmount) {
            setHappyUntil(Date.now() + HAPPY_MS)
            later(() => setHappyUntil(0), HAPPY_MS + 60)
            sound.coin()
            speak('余额 +' + symbol + (nextAmount - previousAmount).toFixed(2) + '，谢谢老板！', 'happy')
          }
          setFlash(nextAmount > previousAmount ? 'up' : 'down')
          later(() => setFlash(''), 1400)
        }

        if (lowRef.current === false && low === true) {
          sound.warn()
          speak('余额不足 ' + symbol + LOW_BALANCE + ' 了，记得充值哦', 'warn')
        }
        lowRef.current = low

        const errorText = snapshot.error !== null && data.ok !== true ? snapshot.error : null
        if (errorText !== null && errorRef.current !== errorText) {
          sound.warn()
          speak('余额读取失败了：' + errorText, 'error')
        }
        errorRef.current = errorText
      }, [data, phase, primary, ledger, activity, snapshot.error, low, later, speak, sound, symbol, amount])

      // The whale reacts to the sound preference and unlocks audio on a gesture.
      useEffect(() => {
        sound.setEnabled(soundOn)
      }, [sound, soundOn])

      // Preload the active skin's frames so a mood change never blinks.
      const activeSkin = useMemo(() => {
        if (skins.length === 0) return undefined
        return skins.find((skin) => skin.id === skinId) ?? skins[0]
      }, [skins, skinId])
      useEffect(() => {
        if (activeSkin === undefined || activeSkin.builtin === true) return
        if (typeof Image === 'undefined') return
        for (const url of Object.values(activeSkin.frames ?? {})) {
          const image = new Image()
          image.src = url
        }
      }, [activeSkin])

      /** The mood: expressions follow work, money, errors and gestures. */
      const mood = dragging
        ? 'excited'
        : mode === 'loading'
          ? 'idle'
          : mode === 'signed-out'
            ? 'sleep'
            : mode === 'error' || phase === 'error'
              ? 'error'
              : phase === 'working'
                ? 'working'
                : low
                  ? 'worried'
                  : happyUntil > Date.now() || flash === 'up'
                    ? 'happy'
                    : 'idle'
      const frameUrl = activeSkin === undefined
        ? undefined
        : activeSkin.frames?.[mood] ?? activeSkin.frames?.idle ?? activeSkin.frames?.work
          ?? Object.values(activeSkin.frames ?? {})[0]

      // Idle chatter: only when calm, visible and not being hovered.
      useEffect(() => {
        if (mood !== 'idle' || hidden) return
        const delay = CHATTER_MIN_MS + Math.random() * CHATTER_SPAN_MS
        const id = window.setTimeout(() => {
          if (document.visibilityState !== 'visible') return
          chatterRef.current += 1
          speak(IDLE_LINES[chatterRef.current % IDLE_LINES.length])
        }, delay)
        return () => window.clearTimeout(id)
      }, [mood, hidden, speak])

      /** Where the widget would land if released right now. */
      const settle = useCallback((from) => {
        const { w, h } = viewport()
        const box = rootRef.current
        const width = box ? box.offsetWidth : sizeRef.current
        const height = box ? box.offsetHeight : sizeRef.current + 30
        const edge = from.x + width / 2 < w / 2 ? 'left' : 'right'
        const x = edge === 'left' ? EDGE_GAP : Math.max(EDGE_GAP, w - width - EDGE_GAP)
        let y = clamp(from.y, EDGE_GAP, h - height - EDGE_GAP)
        if (y + height > h - BOTTOM_MAGNET) y = Math.max(EDGE_GAP, h - height - EDGE_GAP)
        return { x, y, edge }
      }, [])

      /** Snap to the nearest edge, remember it, and let the spring play out. */
      const settleNow = useCallback(() => {
        const before = positionRef.current
        const next = settle(before)
        setPosition(next)
        savePosition(next)
        if (next.edge !== before.edge) sound.pop()
      }, [settle, sound])

      // A resized window can leave the whale outside the viewport.
      useEffect(() => {
        const onResize = () => settleNow()
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [settleNow])

      /** Grab: remember the pointer, the origin and the clock. */
      const onPointerDown = useCallback((event) => {
        if (event.button !== 0 && event.pointerType === 'mouse') return
        if (event.target instanceof Element && event.target.closest('.bw-card,.bw-restore')) return
        sound.unlock()
        sound.tick()
        dragRef.current = {
          id: event.pointerId,
          pointerType: event.pointerType,
          startX: event.clientX,
          startY: event.clientY,
          originX: positionRef.current.x,
          originY: positionRef.current.y,
          moved: 0,
          startedAt: performance.now(),
          lastX: event.clientX,
          lastAt: performance.now(),
          velocity: 0,
        }
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          /* capture is an optimisation, not a requirement */
        }
        setDragging(true)
        setPinned(false)
      }, [sound])

      /** Move: follow the pointer, clamp to the viewport, tilt with speed. */
      const onPointerMove = useCallback((event) => {
        const drag = dragRef.current
        if (drag === null || drag.id !== event.pointerId) return
        const dx = event.clientX - drag.startX
        const dy = event.clientY - drag.startY
        drag.moved = Math.max(drag.moved, Math.hypot(dx, dy))
        const now = performance.now()
        const elapsed = Math.max(1, now - drag.lastAt)
        drag.velocity = (event.clientX - drag.lastX) / elapsed
        drag.lastX = event.clientX
        drag.lastAt = now
        const box = rootRef.current
        const width = box ? box.offsetWidth : sizeRef.current
        const height = box ? box.offsetHeight : sizeRef.current + 30
        const { w, h } = viewport()
        setPosition((previous) => ({
          x: clamp(drag.originX + dx, EDGE_GAP, Math.max(EDGE_GAP, w - width - EDGE_GAP)),
          y: clamp(drag.originY + dy, EDGE_GAP, Math.max(EDGE_GAP, h - height - EDGE_GAP)),
          edge: previous.edge,
        }))
        setTilt(clamp(drag.velocity * 9, -15, 15))
      }, [])

      /** Release: a short tap refreshes, anything else snaps and flips. */
      const onPointerUp = useCallback((event) => {
        const drag = dragRef.current
        dragRef.current = null
        setDragging(false)
        setTilt(0)
        if (drag === null || drag.id !== event.pointerId) return
        try {
          event.currentTarget.releasePointerCapture(event.pointerId)
        } catch {
          /* already released */
        }
        const tapped = drag.moved < CLICK_SLOP && performance.now() - drag.startedAt < 500
        if (tapped) {
          setBoing(true)
          later(() => setBoing(false), 700)
          sound.pop()
          refresh(true)
          if (drag.pointerType === 'touch') setPinned((previous) => !previous)
          return
        }
        sound.boing()
        settleNow()
      }, [later, refresh, settleNow, sound])

      /** A cancelled pointer settles without a click. */
      const onPointerCancel = useCallback((event) => {
        const drag = dragRef.current
        dragRef.current = null
        setDragging(false)
        setTilt(0)
        if (drag === null || drag.id !== event.pointerId) return
        try {
          event.currentTarget.releasePointerCapture(event.pointerId)
        } catch {
          /* already released */
        }
        settleNow()
      }, [settleNow])

      const onKeyDown = useCallback((event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          sound.pop()
          refresh(true)
          return
        }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          const { w } = viewport()
          const forced = settle({ ...positionRef.current, x: event.key === 'ArrowLeft' ? 0 : w })
          setPosition(forced)
          savePosition(forced)
        }
      }, [refresh, settle, sound])

      /** Pick a skin, remember it and greet. */
      const chooseSkin = useCallback((skin) => {
        setSkinId(skin.id)
        saveString(SKIN_KEY, skin.id)
        sound.pop()
        speak('换成「' + skin.name + '」啦～', 'happy')
      }, [sound, speak])

      const flipped = position.edge === 'left'
      const { h: viewportHeight } = viewport()
      const cardBelow = position.y < 210 && viewportHeight - position.y > 280
      const showCard = (hover || pinned) && !dragging
      const headline = data === null || data.signedIn === undefined
        ? '—'
        : data.signedIn === false
          ? '未登录'
          : amount
      const sleepy = mood === 'sleep'

      const card = showCard && hidden === false
        ? h('div', {
            className: 'bw-card',
            style: cardBelow
              ? { top: 'calc(100% + 8px)', [position.edge === 'left' ? 'left' : 'right']: 0 }
              : { bottom: 'calc(100% + 8px)', [position.edge === 'left' ? 'left' : 'right']: 0 },
            onPointerDown: (event) => event.stopPropagation(),
          },
          h('div', { className: 'bw-card-title' },
            h('span', null, '小鲸鱼余额'),
            h('span', { className: 'bw-dot', title: phase === 'working' ? '正在工作' : mode })),

          // Headline + wallet split
          snapshot.error !== null && data === null
            ? h('div', null, '读取失败：' + snapshot.error)
            : data === null || data.signedIn === false
              ? h('div', null, '登录 DeepSeek 账号后，这里会显示实时余额。')
              : h(React.Fragment, null,
                  h('div', { className: 'bw-hero' },
                    h('span', { className: 'bw-cur' }, symbol),
                    h(RollingDigits, { value: amount })),
                  h('div', { className: 'bw-card-row' },
                    h('span', null, '充值 ' + symbol + formatAmount(primary?.recharge ?? '0.00')
                      + ' · 赠送 ' + symbol + formatAmount(primary?.bonus ?? '0.00')),
                    h('span', null, clockTime(data.updatedAt)))),

          h('div', { className: 'bw-card-sep' }),

          // Ledger
          h('div', { className: 'bw-sec' },
            h('div', { className: 'bw-sec-title' },
              h('span', null, '记账'),
              h('span', null, ledger === null ? '—' : '共 ' + ledger.today.turns + ' 轮')),
            h('div', { className: 'bw-card-row' },
              h('span', null, '今日已用'),
              h('b', null, symbol, h(RollingDigits, { value: formatAmount(ledger?.today?.spent ?? 0) }))),
            h('div', { className: 'bw-card-row' },
              h('span', null, '上一轮'),
              h('b', { title: clockTime(ledger?.lastTurn?.at ?? 0) },
                ledger === null || (ledger.lastTurn.delta === 0 && ledger.lastTurn.at === 0)
                  ? '—'
                  : h(React.Fragment, null,
                      symbol,
                      h(RollingDigits, { value: formatAmount(ledger.lastTurn.delta) }),
                      ' · ' + timeAgo(ledger.lastTurn.at)))),
            h('div', { className: 'bw-card-row' },
              h('span', null, '本次启动'),
              h('b', null, symbol, h(RollingDigits, { value: formatAmount(ledger?.sinceStart?.spent ?? 0) }))),
            h(SpendChart, { days: ledger?.days ?? [], today: ledger?.today?.date, currency }),
            h('div', { className: 'bw-recent' },
              (ledger?.recent ?? []).slice(0, 4).map((entry, index) => h('div', {
                className: 'bw-recent-row',
                key: String(entry.at) + '-' + index,
              },
              h('span', null, clockTime(entry.at) + ' · ' + (entry.kind === 'top-up' ? '充值' : toolLabel(entry.tool))),
              h('span', { className: Number(entry.delta) >= 0 ? 'bw-delta-up' : 'bw-delta-down' },
                symbol + formatDelta(entry.delta)))))),

          h('div', { className: 'bw-card-sep' }),

          // Work state
          h('div', { className: 'bw-card-row' },
            h('span', null, '状态'),
            h('b', null, phase === 'working'
              ? '工作中 · ' + toolLabel(activity?.tool)
              : phase === 'error'
                ? '出错了'
                : mode === 'signed-out' ? '未登录' : '空闲')),

          // Actions
          h('div', { className: 'bw-actions' },
            h('button', {
              type: 'button',
              className: 'bw-btn',
              onClick: () => { sound.pop(); refresh(true) },
              'aria-label': '刷新余额',
            }, busy ? '刷新中…' : '刷新'),
            data?.links?.topUpUrl
              ? h('a', { className: 'bw-btn', href: data.links.topUpUrl, target: '_blank', rel: 'noreferrer' }, '充值')
              : null,
            data?.links?.usageUrl
              ? h('a', { className: 'bw-btn', href: data.links.usageUrl, target: '_blank', rel: 'noreferrer' }, '用量')
              : null,
            h('button', {
              type: 'button',
              className: 'bw-btn' + (soundOn ? ' bw-btn-on' : ''),
              'aria-pressed': soundOn,
              onClick: () => {
                const next = !soundOn
                setSoundOn(next)
                saveString(SOUND_KEY, next ? '1' : '0')
                sound.setEnabled(next)
                if (next) { sound.unlock(); sound.hello() }
                speak(next ? '音效打开啦～' : '安静模式', next ? 'happy' : 'info')
              },
            }, soundOn ? '音效 🔊' : '音效 🔇'),
            h('button', {
              type: 'button',
              className: 'bw-btn' + (skinsOpen ? ' bw-btn-on' : ''),
              'aria-expanded': skinsOpen,
              onClick: () => { sound.pop(); setSkinsOpen((previous) => !previous) },
            }, '皮肤 ' + (activeSkin?.name ?? '')),
            h('button', {
              type: 'button',
              className: 'bw-btn',
              onClick: () => {
                setHidden(true)
                saveString(HIDDEN_KEY, '1')
                setPinned(false)
                speak('我先躲起来，随时叫我～', 'info')
              },
            }, '隐藏')),

          // Skin picker
          skinsOpen
            ? h('div', { className: 'bw-sec' },
                h('div', { className: 'bw-skins' }, skins.map((skin) => {
                  const thumb = skin.builtin === true
                    ? h('span', {
                        className: 'bw-thumb',
                        dangerouslySetInnerHTML: { __html: WHALE_SVG.replace('{SYM}', () => symbol) },
                      })
                    : h('img', { src: skin.frames?.idle, alt: skin.name, draggable: false })
                  return h('button', {
                    type: 'button',
                    key: skin.id,
                    className: 'bw-skin' + (skin.id === activeSkin?.id ? ' bw-skin-active' : ''),
                    title: skin.name,
                    onClick: () => chooseSkin(skin),
                  }, thumb)
                })))
            : null,

          h('div', { className: 'bw-hint' }, '拖动吸附左右边缘 · 左吸附翻转 · 单击刷新 · 悬停看记账'))
        : null

      if (hidden) {
        const thumb = activeSkin === undefined || activeSkin.builtin === true
          ? h('span', {
              className: 'bw-restore-art',
              dangerouslySetInnerHTML: { __html: WHALE_SVG.replace('{SYM}', () => symbol) },
            })
          : h('span', { className: 'bw-restore-art' },
              h('img', { src: activeSkin.frames?.idle, alt: '', draggable: false }))
        return h('div', {
          ref: rootRef,
          className: 'bw-root',
          'data-edge': position.edge,
          style: {
            transform: 'translate3d(' + position.x + 'px,' + position.y + 'px,0)',
            transition: 'transform .5s cubic-bezier(.22,1.4,.36,1)',
          },
        }, h('button', {
          type: 'button',
          className: 'bw-restore',
          title: '召唤小鲸鱼余额挂件',
          onClick: () => {
            setHidden(false)
            saveString(HIDDEN_KEY, '0')
            sound.unlock()
            sound.hello()
            refresh(true)
            speak('我回来啦～', 'happy')
          },
        }, thumb, '余额'))
      }

      return h('div', {
        ref: rootRef,
        className: 'bw-root',
        role: 'button',
        tabIndex: 0,
        'aria-label': data !== null && data.signedIn === false
          ? '小鲸鱼余额挂件：未登录'
          : '小鲸鱼余额挂件：余额 ' + symbol + headline,
        'data-edge': position.edge,
        'data-mode': mode,
        'data-mood': mood,
        'data-dragging': dragging ? '1' : '0',
        'data-hover': showCard ? '1' : '0',
        'data-flash': flash,
        'data-bubble': bubble === null ? '0' : '1',
        style: {
          transform: 'translate3d(' + position.x + 'px,' + position.y + 'px,0)',
          transition: dragging ? 'none' : 'transform .58s cubic-bezier(.22,1.45,.36,1)',
          '--bw-accent': activeSkin?.accent ?? '#4D6BFE',
        },
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel,
        onPointerEnter: () => setHover(true),
        onPointerLeave: () => { setHover(false); setPinned(false) },
        onKeyDown,
        onDoubleClick: settleNow,
      },
      h('div', { className: 'bw-stack' },
        h('div', { className: 'bw-bubble', 'data-tone': bubble?.tone ?? 'info' }, bubble?.text ?? ''),
        h('div', {
          className: 'bw-flip',
          style: { transform: 'scaleX(' + (flipped ? -1 : 1) + ')', width: size, height: size },
        },
        h('span', { className: 'bw-ring' }),
        h('div', {
          className: 'bw-spring',
          'data-boing': boing ? '1' : '0',
          'data-dragging': dragging ? '1' : '0',
          style: {
            position: 'relative',
            width: '100%',
            height: '100%',
            transform: dragging ? 'rotate(' + tilt + 'deg)' : 'none',
          },
        }, h(SkinArt, { skin: activeSkin, frameUrl, currency, busy, sleepy }))),
        h(MoodProps, { mood }),
        h('div', { className: 'bw-pill' },
          h('span', { className: 'bw-cur' }, data !== null && data.signedIn === true ? symbol : ''),
          data !== null && data.signedIn === false
            ? h('span', { className: 'bw-num' }, '未登录')
            : h(RollingDigits, { value: headline }),
          h('span', { className: 'bw-dot' }))),
      card)
    }

    /** Every style the widget owns, inserted once per activation. */
    function installStyles() {
      const tag = document.createElement('style')
      tag.dataset.plugin = PLUGIN_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    return {
      inject: ['slots'],
      /**
       * Register the widget's style sheet and its `shell.overlay` occupant.
       * Both registrations belong to this plugin's fiber, so unloading the
       * plugin removes the styles and the slot entry together.
       */
      apply(ctx) {
        ctx.effect(installStyles, PLUGIN_ID + ': styles')
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'balance-whale',
          order: 20,
          label: () => '小鲸鱼余额',
        }, BalanceWhale))
      },
    }
  },
})
