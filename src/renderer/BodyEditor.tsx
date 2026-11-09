import { useEffect, useRef } from "react";
import {
  EditorState,
  StateEffect,
  StateField,
  type Extension,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
} from "@codemirror/commands";

export interface ReviewDecoration {
  from: number;
  to: number;
  kind: "pending" | "selected" | "accepted";
  /** 删除／插入锚点：不写入正文，只在编辑器里显示标记。 */
  anchor?: boolean;
  label?: string;
}

export interface ScrollRequest {
  from: number;
  to: number;
  key: string;
}

const CLASS_BY_KIND: Record<ReviewDecoration["kind"], string> = {
  pending: "cm-review-pending",
  selected: "cm-review-selected",
  accepted: "cm-review-accepted",
};

const setReviewDecorations = StateEffect.define<ReviewDecoration[]>();

class DeletionAnchorWidget extends WidgetType {
  constructor(private readonly label: string) {
    super();
  }
  eq(other: DeletionAnchorWidget): boolean {
    return other.label === this.label;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-deletion-anchor";
    span.setAttribute("role", "note");
    span.textContent = this.label;
    return span;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

function buildDecorations(state: EditorState, decorations: ReviewDecoration[]): DecorationSet {
  const length = state.doc.length;
  const marks: Array<Range<Decoration>> = [];
  const widgets: Array<Range<Decoration>> = [];
  const seenAnchors = new Set<number>();
  for (const item of decorations) {
    const from = Math.max(0, Math.min(length, item.from));
    const to = Math.max(from, Math.min(length, item.to));
    if (item.anchor) {
      if (seenAnchors.has(from)) continue;
      seenAnchors.add(from);
      widgets.push(
        Decoration.widget({
          widget: new DeletionAnchorWidget(item.label ?? "已删除段落"),
          side: 1,
        }).range(from),
      );
      continue;
    }
    if (to <= from) continue;
    marks.push(Decoration.mark({ class: CLASS_BY_KIND[item.kind] }).range(from, to));
  }
  marks.sort((left, right) => left.from - right.from || left.to - right.to);
  widgets.sort((left, right) => left.from - right.from);
  return Decoration.set([...marks, ...widgets], true);
}

function reviewExtension(): Extension {
  const field = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(decorations, transaction) {
      let next = decorations.map(transaction.changes);
      for (const effect of transaction.effects) {
        if (effect.is(setReviewDecorations))
          next = buildDecorations(transaction.state, effect.value);
      }
      return next;
    },
    provide: (value) => EditorView.decorations.from(value),
  });
  return field;
}

export function BodyEditor({
  chapterKey,
  value,
  onChange,
  onSelectionChange,
  onSave,
  label,
  decorations,
  scrollRequest,
}: {
  chapterKey: string;
  value: string;
  onChange: (text: string) => void;
  onSelectionChange: (offset: number) => void;
  onSave: () => void;
  label: string;
  decorations?: ReviewDecoration[];
  scrollRequest?: ScrollRequest | null;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const changeRef = useRef(onChange);
  const selectionRef = useRef(onSelectionChange);
  const saveRef = useRef(onSave);
  changeRef.current = onChange;
  selectionRef.current = onSelectionChange;
  saveRef.current = onSave;

  useEffect(() => {
    if (!host.current) return;
    const instance = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          EditorView.editable.of(true),
          EditorView.lineWrapping,
          history(),
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                saveRef.current();
                return true;
              },
            },
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) changeRef.current(update.state.doc.toString());
            if (update.selectionSet || update.docChanged)
              selectionRef.current(update.state.selection.main.head);
          }),
          EditorView.theme({
            "&": { minHeight: "320px" },
            ".cm-scroller": { overflow: "visible" },
            ".cm-content": { padding: "0" },
            ".cm-line": { padding: "0" },
          }),
          reviewExtension(),
        ],
      }),
      parent: host.current,
    });
    view.current = instance;
    selectionRef.current(instance.state.selection.main.head);
    return () => {
      instance.destroy();
      view.current = null;
    };
    // 只在切换章节时重建编辑器；正文变化通过下一个 effect 同步。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterKey]);

  useEffect(() => {
    const instance = view.current;
    if (!instance) return;
    const current = instance.state.doc.toString();
    if (current === value) return;
    instance.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value, chapterKey]);

  useEffect(() => {
    const instance = view.current;
    if (!instance) return;
    instance.dispatch({
      effects: setReviewDecorations.of(decorations ?? []),
    });
  }, [decorations, chapterKey]);

  useEffect(() => {
    const instance = view.current;
    if (!instance || !scrollRequest) return;
    const length = instance.state.doc.length;
    const from = Math.max(0, Math.min(length, scrollRequest.from));
    instance.dispatch({
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
    instance.focus();
    // 只按请求 key 触发，避免父组件重渲染时反复滚动。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRequest?.key]);

  return (
    <div
      className="bb-editor"
      ref={host}
      aria-label={label}
      data-testid="body-editor"
    />
  );
}
