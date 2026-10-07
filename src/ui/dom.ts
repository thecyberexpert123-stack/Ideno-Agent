/**
 * A very small DOM builder.
 *
 * It exists for one reason: everything Ideno renders comes from a language model
 * or from a user, and `innerHTML` turns either into an XSS vector the moment
 * someone forgets to escape. Here there is nothing to forget — text only ever
 * reaches the DOM through `textContent`, so a model that emits
 * `<img onerror=...>` produces visible text, not an element.
 *
 * It is deliberately not a framework: no virtual DOM, no reactivity, no
 * dependency. Components are functions that return elements, and panels are
 * re-rendered wholesale when the state changes.
 */

export type Child = Node | string | number | null | undefined | false | Child[];

export interface ElProps {
  class?: string;
  text?: string;
  title?: string;
  disabled?: boolean;
  /**
   * Initial checked state for a checkbox or radio.
   *
   * Without this, a component has to find its own inputs after building and set them by
   * position — which silently breaks the moment another checkbox is added above them.
   */
  checked?: boolean;
  value?: string;
  type?: string;
  placeholder?: string;
  href?: string;
  /** Accessibility and ARIA attributes, applied verbatim. */
  role?: string;
  tabIndex?: number;
  ariaLabel?: string;
  ariaSelected?: boolean;
  ariaCurrent?: boolean;
  dataset?: Record<string, string>;
  onClick?: (event: MouseEvent) => void;
  onInput?: (event: Event) => void;
  onChange?: (event: Event) => void;
  onSubmit?: (event: SubmitEvent) => void;
  onKeyDown?: (event: KeyboardEvent) => void;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  if (props) {
    if (props.class !== undefined) node.className = props.class;
    if (props.text !== undefined) node.textContent = props.text;
    if (props.title !== undefined) node.title = props.title;
    if (props.disabled !== undefined) {
      node.toggleAttribute('disabled', props.disabled);
      if (props.disabled) node.setAttribute('aria-disabled', 'true');
    }
    if (props.checked !== undefined && 'checked' in node) {
      (node as HTMLInputElement).checked = props.checked;
    }
    if (props.href !== undefined) node.setAttribute('href', props.href);
    if (props.role !== undefined) node.setAttribute('role', props.role);
    if (props.tabIndex !== undefined) node.tabIndex = props.tabIndex;
    if (props.ariaLabel !== undefined) node.setAttribute('aria-label', props.ariaLabel);
    if (props.ariaSelected !== undefined) node.setAttribute('aria-selected', String(props.ariaSelected));
    if (props.ariaCurrent !== undefined) node.setAttribute('aria-current', String(props.ariaCurrent));
    if (props.dataset) {
      for (const [key, value] of Object.entries(props.dataset)) node.dataset[key] = value;
    }
    // The DOM's addEventListener signature is deliberately loose; these casts keep
    // the ergonomic handler types at the call site without weakening them here.
    if (props.onClick) node.addEventListener('click', props.onClick as EventListener);
    if (props.onInput) node.addEventListener('input', props.onInput as EventListener);
    if (props.onChange) node.addEventListener('change', props.onChange as EventListener);
    if (props.onSubmit) node.addEventListener('submit', props.onSubmit as EventListener);
    if (props.onKeyDown) node.addEventListener('keydown', props.onKeyDown as EventListener);

    // Form controls are the one place `value` and `type` mean something. `option`
    // is included because a `<select>` built from data is worthless if every option
    // carries an empty value — the selected branch and the one submitted would not
    // be the same thing.
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'option') {
      const field = node as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLOptionElement;
      if (props.value !== undefined) field.value = props.value;
      if (props.type !== undefined && 'type' in field) (field as HTMLInputElement).type = props.type;
      if (props.placeholder !== undefined && 'placeholder' in field) {
        (field as HTMLInputElement).placeholder = props.placeholder;
      }
    }
    // A button inside a form defaults to submit; callers say what they mean.
    if (tag === 'button' && props.type !== undefined) node.setAttribute('type', props.type);
  }

  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      append(parent, child);
      continue;
    }
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Replaces a container's contents in one operation. */
export function render(container: Element, ...children: Child[]): void {
  clear(container);
  append(container, children);
}

/**
 * A disclosure element. Used wherever the honest thing to do is show the detail
 * without shouting it: validation issues, a rejected model response, a diff.
 */
export function details(summaryText: string, ...children: Child[]): HTMLDetailsElement {
  return el('details', { class: 'disclosure' }, el('summary', { text: summaryText }), ...children);
}

export function button(label: string, options: ElProps & { variant?: 'primary' | 'ghost' | 'danger' } = {}): HTMLButtonElement {
  const { variant, class: className, ...rest } = options;
  const classes = ['btn', variant ? `btn-${variant}` : '', className ?? ''].filter(Boolean).join(' ');
  return el('button', { ...rest, class: classes, text: label, type: 'button' });
}
