import { UI_PERMISSION_GROUPS } from "../generated/ui-config.js";
import { CURRENT_PERMISSION_IDS, type PermissionId } from "../shared/admin-protocol.js";
import { formatNumber, onLocaleChanged, t, type UiMessageKey } from "../ui/page-ui.js";

interface GroupControls {
  readonly labelKey: UiMessageKey;
  readonly permissionIds: readonly PermissionId[];
  readonly input: HTMLInputElement;
  readonly name: HTMLSpanElement;
  readonly count: HTMLElement;
  readonly expand: HTMLButtonElement;
}

function selectionLabel(className: string) {
  const label = document.createElement("label");
  label.className = className;
  const input = document.createElement("input");
  input.type = "checkbox";
  const name = document.createElement("span");
  const count = document.createElement("bdi");
  count.dir = "ltr";
  count.className = "permission-selection-count";
  label.append(input, name, count);
  return { label, input, name, count };
}

export function createPermissionPicker(container: HTMLElement, initial: readonly PermissionId[]) {
  const inputs = new Map<PermissionId, HTMLInputElement>();
  const groups: GroupControls[] = [];
  const all = selectionLabel("permission-select-all");
  all.input.dataset.permissionsAll = "";
  container.append(all.label);

  function reflectSelection(input: HTMLInputElement, count: HTMLElement, selected: number, total: number): void {
    input.checked = selected === total;
    input.indeterminate = selected > 0 && selected < total;
    count.textContent = `${formatNumber(selected)} / ${formatNumber(total)}`;
  }

  function refresh(): void {
    let totalSelected = 0;
    for (const group of groups) {
      let selected = 0;
      for (const id of group.permissionIds) if (inputs.get(id)?.checked === true) selected += 1;
      totalSelected += selected;
      reflectSelection(group.input, group.count, selected, group.permissionIds.length);
      group.name.textContent = t(group.labelKey);
      group.expand.setAttribute("aria-label", t(group.labelKey));
    }
    all.name.textContent = t("allPermissions");
    reflectSelection(all.input, all.count, totalSelected, inputs.size);
  }

  for (const definition of UI_PERMISSION_GROUPS) {
    const section = document.createElement("section");
    section.className = "permission-group";
    section.dataset.permissionGroup = definition.groupId;
    const header = document.createElement("div");
    header.className = "permission-group-header";
    const group = selectionLabel("permission-group-select");
    group.input.dataset.permissionGroupToggle = definition.groupId;
    const expand = document.createElement("button");
    expand.type = "button";
    expand.className = "permission-group-expand";
    expand.dataset.permissionGroupExpand = definition.groupId;
    expand.setAttribute("aria-expanded", "false");
    const panel = document.createElement("div");
    panel.className = "permission-grid permission-group-members";
    panel.id = `${container.id}-${definition.groupId}`;
    panel.hidden = true;
    expand.setAttribute("aria-controls", panel.id);
    expand.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      expand.setAttribute("aria-expanded", String(!panel.hidden));
    });
    group.input.addEventListener("change", () => {
      for (const id of definition.permissionIds) inputs.get(id)!.checked = group.input.checked;
      refresh();
    });
    for (const permissionId of definition.permissionIds) {
      const label = document.createElement("label");
      label.className = "permission-option";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.permissionId = permissionId;
      const copy = document.createElement("span");
      copy.className = "permission-copy";
      const name = document.createElement("strong");
      name.textContent = permissionId;
      copy.append(name);
      label.append(input, copy);
      panel.append(label);
      inputs.set(permissionId, input);
      input.addEventListener("change", refresh);
    }
    groups.push({ ...group, expand, labelKey: definition.labelKey, permissionIds: definition.permissionIds });
    header.append(group.label, expand);
    section.append(header, panel);
    container.append(section);
  }

  all.input.addEventListener("change", () => {
    for (const input of inputs.values()) input.checked = all.input.checked;
    refresh();
  });

  function setSelection(permissions: readonly PermissionId[]): void {
    const selected = new Set(permissions);
    for (const [id, input] of inputs) input.checked = selected.has(id);
    refresh();
  }

  setSelection(initial);
  onLocaleChanged(refresh);
  return {
    selectedPermissions: (): readonly PermissionId[] => CURRENT_PERMISSION_IDS.filter((id) => inputs.get(id)?.checked === true),
    setSelection,
    setDisabled(disabled: boolean): void {
      all.input.disabled = disabled;
      for (const group of groups) {
        group.input.disabled = disabled;
        group.expand.disabled = disabled;
      }
      for (const input of inputs.values()) input.disabled = disabled;
    },
  };
}
