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

/** 触发按钮与可导航的行；均为 Paseo e2e 套件依赖的稳定 testID。
 * 模型选择器有两种形态：桌面宽屏是 CombinedModelSelector（Combobox 浮层，
 * 无独立视口容器），窄屏/移动是 CompactModelSheet（AdaptiveModalSheet）。
 * 两种形态的行都只在弹层打开时渲染，因此「行存在」即「弹层打开」。 */
const TRIGGER_SELECTOR = '[data-testid="combined-model-selector"]';
const ROW_SELECTOR = [
  '[data-testid^="model-row-"]',
  '[data-testid^="model-provider-"]',
  '[data-testid^="model-profile-row-"]',
].join(",");

/** 弹层搜索框（model-search-all-input / model-search-input）同样只在弹层
 *  打开时渲染；作为「弹层打开」的兜底信号。 */
const SEARCH_INPUT_SELECTOR = '[data-testid^="model-search"]';

/** 高亮行打上的标记属性。用「属性选择器 + 注入样式」画高亮，React 重渲染不会冲掉。 */
const ACTIVE_ATTR = "data-model-nav-active";

/**
 * 列表是 FlatList（虚拟化），DOM 里只有可视窗口附近的行。移动目标落在
 * 已渲染窗口之外时，先滚动边缘行触发更多渲染，每帧重试，最多等这么多帧。
 */
const EDGE_FRAMES = 4;

/** 与 Paseo 自身 keyboard/focus-scope.ts 相同的终端判定。 */
const TERMINAL_SELECTOR = '[data-testid="terminal-surface"], .xterm';

export default function contribute(client: PluginClientContext): () => void {
  const style = injectHighlightStyle();
  const nav = {
    pending: null as Direction | null,
    active: null as HTMLElement | null,
    pumping: false,
    edgeFrames: 0,
    userWantsSearch: false,
    redirectTries: 0,
  };

  function sheetRows(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>(ROW_SELECTOR));
  }

  function modelSheetOpen(): boolean {
    return (
      document.querySelector(ROW_SELECTOR) !== null ||
      document.querySelector(SEARCH_INPUT_SELECTOR) !== null
    );
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
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(TRIGGER_SELECTOR));
    const trigger = candidates.find(isVisible);
    console.info(
      `[model-hotkeys] openModelSheet: ${candidates.length} trigger(s) in DOM, ` +
        `visible: ${trigger ? "yes" : "no"}`,
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

  function inTerminalScope(): boolean {
    const active = document.activeElement;
    return Boolean(active && active.closest(TERMINAL_SELECTOR));
  }

  /**
   * 实测（macOS + 中文输入法）：焦点位于文本输入框内时，Ctrl+N/P 的
   * keydown 会被 macOS 输入层整体消费、从不派发给页面（Ctrl+M、Enter
   * 则正常到达；焦点在非文本元素上时 Ctrl+N/P 正常到达——均已实测）。
   * 弹层打开时应用会把焦点自动放进搜索框，因此在搜索框获得焦点时把
   * 焦点重定向到列表行（非文本元素），导航键才能离开文本上下文。
   * 焦点仍在弹层作用域内，不会触发应用浮层的焦点强制回收。
   * 唯一豁免：用户主动点击搜索框（pointerdown）想打字过滤时不再抢焦点。
   */
  function redirectFocusToRow(): void {
    const rows = sheetRows();
    if (rows.length === 0) {
      // FlatList 的行是异步挂载的，逐帧重试一段时间。
      if (nav.redirectTries++ < 40) {
        requestAnimationFrame(redirectFocusToRow);
        return;
      }
      console.warn("[model-hotkeys] focus redirect gave up: no rows rendered");
      nav.redirectTries = 0;
      return;
    }
    nav.redirectTries = 0;
    const row = selectedRow(rows) ?? rows[0];
    highlight(row);
    row.focus({ preventScroll: false });
    console.info("[model-hotkeys] focus redirected to row:", row.getAttribute("data-testid"));
  }

  function handleFocusIn(event: FocusEvent): void {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest(SEARCH_INPUT_SELECTOR)) {
      if (nav.userWantsSearch) {
        console.debug("[model-hotkeys] search focus respected (user intent)");
        return;
      }
      console.debug("[model-hotkeys] search autofocused; redirecting focus to row");
      nav.redirectTries = 0;
      redirectFocusToRow();
      return;
    }
    if (!modelSheetOpen()) {
      nav.userWantsSearch = false;
    }
  }

  function handlePointerDown(event: PointerEvent): void {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest(SEARCH_INPUT_SELECTOR)) {
      nav.userWantsSearch = true;
      console.debug("[model-hotkeys] user pressed search input; will keep focus there");
    }
  }  /** 同步执行一次移动；目标行未渲染时保持 pending 并逐帧重试。 */
  function pump(): void {
    try {
      pumpStep();
    } catch (error) {
      console.error("[model-hotkeys] pump error:", error);
      nav.pending = null;
      nav.pumping = false;
      nav.edgeFrames = 0;
    }
  }

  function pumpStep(): void {
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
    try {
      handleKeyDown(event);
    } catch (error) {
      console.error("[model-hotkeys] handler error:", error);
    }
  }

  function handleKeyDown(event: KeyboardEvent): void {
    const key = event.key;
    const code = event.code;
    const lower = key.length === 1 ? key.toLowerCase() : key;

    if (
      (event.ctrlKey && !event.metaKey && "mnp".includes(lower)) ||
      code === "KeyM" ||
      code === "KeyN" ||
      code === "KeyP" ||
      key === "ArrowDown" ||
      key === "ArrowUp" ||
      key === "Enter"
    ) {
      const focus = document.activeElement;
      console.info(
        `[model-hotkeys] key=${key} code=${code} ctrl=${event.ctrlKey} ` +
          `composing=${event.isComposing} open=${modelSheetOpen()} ` +
          `rows=${document.querySelectorAll(ROW_SELECTOR).length} ` +
          `search=${document.querySelectorAll(SEARCH_INPUT_SELECTOR).length} ` +
          `focus=${focus?.getAttribute?.("data-testid") ?? focus?.tagName ?? "none"}`,
      );
    }

    // 中文 IME 组合期间普通按键交给输入法；带修饰键的组合键不参与组字，
    // 且 macOS 文本系统可能以 key="Process" 或 isComposing 送达，照常处理。
    if (event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey) return;

    const sheetOpen = modelSheetOpen();

    // Ctrl+M：切换模型弹层。终端里 Ctrl+M 是回车（CR），原样放行。
    // 匹配同时看 key 与物理键码 code（IME 可能改写 key 甚至置为 Process）。
    if (
      event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      (lower === "m" || code === "KeyM")
    ) {
      if (inTerminalScope()) {
        console.debug("[model-hotkeys] Ctrl+M skipped: terminal focus");
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (sheetOpen) {
        closeModelSheet();
      } else {
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
      if ((event.ctrlKey && (lower === "n" || code === "KeyN")) || key === "ArrowDown")
        dir = "down";
      else if ((event.ctrlKey && (lower === "p" || code === "KeyP")) || key === "ArrowUp")
        dir = "up";
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
      // 没移动过高亮时，Enter 落在当前已选中的模型行上（等于确认现状）。
      const row =
        (nav.active && rows.includes(nav.active) ? nav.active : null) ??
        selectedRow(rows) ??
        ((document.activeElement?.closest(ROW_SELECTOR) as HTMLElement | null) ?? null);
      if (row && rows.includes(row)) {
        event.preventDefault();
        nav.pending = null;
        syntheticClick(row);
      }
    }
  }

  // 诊断探针：Command Center（Cmd+K）里的手动入口。它的出现证明本插件
  // 已被应用评估执行；它本身也能走同一条路径打开模型选择弹层。
  const removeCommandCenterItem = client.addCommandCenterItem({
    id: "open-model-picker",
    title: "Model Hotkeys: Open model picker",
    icon: "ListFilter",
    context: "global",
    onSelect: () => openModelSheet(),
  });

  const removeDumpItem = client.addCommandCenterItem({
    id: "dump-diagnostics",
    title: "Model Hotkeys: Dump diagnostics",
    icon: "Bug",
    context: "global",
    onSelect: () => {
      const testIds = Array.from(document.querySelectorAll("[data-testid]"))
        .map((el) => el.getAttribute("data-testid"))
        .filter((id): id is string => Boolean(id));
      const focus = document.activeElement;
      console.info("[model-hotkeys] diagnostics", {
        listenerAlive: sentinel.active,
        open: modelSheetOpen(),
        rows: document.querySelectorAll(ROW_SELECTOR).length,
        searchInputs: document.querySelectorAll(SEARCH_INPUT_SELECTOR).length,
        focusTestId: focus?.getAttribute?.("data-testid") ?? null,
        totalTestIds: testIds.length,
        modelishTestIds: testIds.filter((id) =>
          /model|profile|provider|search|selector|sheet/i.test(id),
        ),
      });
    },
  });

  const sentinel = { active: true };
  (window as { __modelHotkeysActive?: boolean }).__modelHotkeysActive = true;

  console.info("[model-hotkeys] client bundle evaluated; keydown listener installed");

  window.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("focusin", handleFocusIn, true);
  document.addEventListener("pointerdown", handlePointerDown, true);
  return () => {
    window.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("focusin", handleFocusIn, true);
    document.removeEventListener("pointerdown", handlePointerDown, true);
    sentinel.active = false;
    delete (window as { __modelHotkeysActive?: boolean }).__modelHotkeysActive;
    removeCommandCenterItem();
    removeDumpItem();
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
