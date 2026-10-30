/**
 * Paseo 插件：为对话输入框下方的模型选择器补齐键盘操作。
 *
 *   Ctrl+M          打开 / 关闭模型选择弹层
 *   Ctrl+N 或 ↓     高亮下一项
 *   Ctrl+P 或 ↑     高亮上一项
 *   Enter           确认高亮项（等价于点击该行）
 *   Escape          关闭弹层（Paseo 原生行为）
 *
 * 原理：插件客户端代码由 Paseo 在渲染进程主世界用 `globalThis.eval` 执行
 * （paseo 源码 packages/app/src/plugins/evaluate.ts），与页面共享同一
 * window/document。这里在 window 捕获阶段监听 keydown，用 data-testid
 * 定位元素，并以合成 click 驱动 RN-web Pressable——其 onPress 由原生
 * click 事件触发（react-native-web usePressEvents/PressResponder.js），
 * 不校验 isTrusted，因此 el.dispatchEvent(click) 即可精确激活一次。
 */
import type { PluginClientContext } from "@getpaseo/plugin/client";

type Direction = "down" | "up";

/** 触发按钮、弹层视口、可导航的行；均为 Paseo e2e 套件依赖的稳定 testID。 */
const TRIGGER_SELECTOR = '[data-testid="combined-model-selector"]';
const VIEWPORT_SELECTOR = '[data-testid="agent-controls-model-viewport"]';
const ROW_SELECTOR = [
  '[data-testid^="model-row-"]',
  '[data-testid^="model-provider-"]',
  '[data-testid^="model-profile-row-"]',
].join(",");

/** 高亮行打上的标记属性。用「属性选择器 + 注入样式」画高亮，React 重渲染不会冲掉。 */
const ACTIVE_ATTR = "data-model-nav-active";

/**
 * 列表是 FlatList（虚拟化），DOM 里只有可视窗口附近的行。移动目标落在
 * 已渲染窗口之外时，先滚动边缘行触发更多渲染，每帧重试，最多等这么多帧。
 */
const EDGE_FRAMES = 4;

/** 与 Paseo 自身 keyboard/focus-scope.ts 相同的终端判定。 */
const TERMINAL_SELECTOR = '[data-testid="terminal-surface"], .xterm';

export default function contribute(_client: PluginClientContext): () => void {
  const style = injectHighlightStyle();
  const nav = {
    pending: null as Direction | null,
    active: null as HTMLElement | null,
    pumping: false,
    edgeFrames: 0,
  };

  function modelSheet(): HTMLElement | null {
    return document.querySelector<HTMLElement>(VIEWPORT_SELECTOR);
  }

  function sheetRows(): HTMLElement[] {
    const sheet = modelSheet();
    return sheet ? Array.from(sheet.querySelectorAll<HTMLElement>(ROW_SELECTOR)) : [];
  }

  /** 弹层打开时初始高亮：优先落在当前已选中的模型行上。 */
  function selectedRow(rows: HTMLElement[]): HTMLElement | null {
    return rows.find((row) => row.getAttribute("aria-selected") === "true") ?? null;
  }

  function highlight(row: HTMLElement | null): void {
    for (const stale of document.querySelectorAll(`[${ACTIVE_ATTR}]`)) {
      stale.removeAttribute(ACTIVE_ATTR);
    }
    nav.active = row;
    if (row) row.setAttribute(ACTIVE_ATTR, "true");
  }

  function syntheticClick(el: HTMLElement): void {
    const rect = el.getBoundingClientRect();
    el.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 0,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }),
    );
  }

  function isVisible(el: HTMLElement): boolean {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return typeof el.checkVisibility !== "function" || el.checkVisibility();
  }

  function openModelSheet(): void {
    // 分屏时存在多个 composer，取第一个可见的触发按钮（与 e2e 行为一致）。
    const trigger = Array.from(document.querySelectorAll<HTMLElement>(TRIGGER_SELECTOR)).find(
      isVisible,
    );
    if (trigger) syntheticClick(trigger);
  }

  function closeModelSheet(): void {
    // Paseo 在 window 捕获阶段监听 keydown 并把 Escape 交给顶层弹层
    // （packages/app/src/lib/overlay-root.ts），合成事件同样能到达。
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", cancelable: true }),
    );
  }

  function overlayRootHasChildren(): boolean {
    const root = document.getElementById("overlay-root");
    return Boolean(root && root.childElementCount > 0);
  }

  function inTerminalScope(): boolean {
    const active = document.activeElement;
    return Boolean(active && active.closest(TERMINAL_SELECTOR));
  }

  /** 同步执行一次移动；目标行未渲染时保持 pending 并逐帧重试。 */
  function pump(): void {
    if (!nav.pending) {
      nav.pumping = false;
      return;
    }
    const dir = nav.pending;
    const rows = sheetRows();

    if (rows.length === 0) {
      nav.pending = null;
    } else if (nav.active === null) {
      const row = selectedRow(rows) ?? rows[dir === "down" ? 0 : rows.length - 1];
      highlight(row);
      row.scrollIntoView({ block: "nearest" });
      nav.pending = null;
      nav.edgeFrames = 0;
    } else {
      const activeIndex = rows.indexOf(nav.active);
      // 高亮行被过滤或虚拟化回收后，从列表对应端重新开始。
      const from = activeIndex === -1 ? (dir === "down" ? -1 : rows.length) : activeIndex;
      const target = from + (dir === "down" ? 1 : -1);
      if (target >= 0 && target < rows.length) {
        highlight(rows[target]);
        rows[target].scrollIntoView({ block: "nearest" });
        nav.pending = null;
        nav.edgeFrames = 0;
      } else {
        // 目标在已渲染窗口之外：滚动极端行让 FlatList 渲染出更多行再试。
        rows[dir === "down" ? rows.length - 1 : 0].scrollIntoView({
          block: dir === "down" ? "end" : "start",
        });
        nav.edgeFrames += 1;
      }
    }

    if (!nav.pending || nav.edgeFrames > EDGE_FRAMES) {
      nav.pending = null;
      nav.pumping = false;
      nav.edgeFrames = 0;
      return;
    }
    requestAnimationFrame(pump);
  }

  function nudge(dir: Direction): void {
    nav.pending = dir;
    if (!nav.pumping) {
      nav.pumping = true;
      pump();
    }
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    const key = event.key;
    const lower = key.length === 1 ? key.toLowerCase() : key;
    const sheetOpen = Boolean(modelSheet());

    // Ctrl+M：切换模型弹层。终端里 Ctrl+M 是回车（CR），原样放行。
    if (
      event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      lower === "m"
    ) {
      if (inTerminalScope()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (sheetOpen) {
        closeModelSheet();
      } else if (!overlayRootHasChildren()) {
        openModelSheet();
      }
      return;
    }

    if (key === "Escape") {
      nav.pending = null;
      highlight(null);
      return;
    }

    if (!sheetOpen) return;

    let dir: Direction | null = null;
    if (!event.metaKey && !event.altKey && !event.shiftKey) {
      if ((event.ctrlKey && lower === "n") || key === "ArrowDown") dir = "down";
      else if ((event.ctrlKey && lower === "p") || key === "ArrowUp") dir = "up";
    }
    if (dir) {
      // 焦点在弹层搜索框里：拦下按键，避免落入输入框，改由导航消费。
      event.preventDefault();
      event.stopImmediatePropagation();
      nudge(dir);
      return;
    }

    if (key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const rows = sheetRows();
      const row =
        nav.active && rows.includes(nav.active)
          ? nav.active
          : ((document.activeElement?.closest(ROW_SELECTOR) as HTMLElement | null) ?? null);
      if (row && rows.includes(row)) {
        event.preventDefault();
        nav.pending = null;
        syntheticClick(row);
      }
    }
  }

  window.addEventListener("keydown", onKeyDown, true);
  return () => {
    window.removeEventListener("keydown", onKeyDown, true);
    highlight(null);
    style.remove();
  };
}

function injectHighlightStyle(): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = `
    [${ACTIVE_ATTR}="true"] {
      outline: 2px solid #3b82f6 !important;
      outline-offset: -2px !important;
      background-color: rgba(59, 130, 246, 0.16) !important;
    }
  `;
  document.head.appendChild(style);
  return style;
}
