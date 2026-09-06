export function validatePermissionGroups(groups, activePermissionIds, messageKeys) {
  if (!Array.isArray(groups) || groups.length === 0) throw new Error("UI permission groups must not be empty");
  const active = new Set(activePermissionIds);
  const messages = new Set(messageKeys);
  const groupIds = new Set();
  const assigned = new Set();
  for (const group of groups) {
    if (typeof group !== "object" || group === null ||
        typeof group.groupId !== "string" || !/^[a-z][a-z0-9-]*$/u.test(group.groupId) ||
        groupIds.has(group.groupId)) throw new Error("Invalid or duplicate UI permission group ID");
    groupIds.add(group.groupId);
    if (!messages.has(group.labelKey)) throw new Error(`Unknown UI permission group label: ${group.groupId}`);
    if (!Array.isArray(group.permissionIds) || group.permissionIds.length === 0) {
      throw new Error(`UI permission group must have members: ${group.groupId}`);
    }
    for (const permissionId of group.permissionIds) {
      if (!active.has(permissionId)) throw new Error(`Unknown or inactive UI permission: ${permissionId}`);
      if (assigned.has(permissionId)) throw new Error(`Duplicate UI permission assignment: ${permissionId}`);
      assigned.add(permissionId);
    }
  }
  const missing = activePermissionIds.filter((permissionId) => !assigned.has(permissionId));
  if (missing.length !== 0) throw new Error(`Ungrouped active UI permissions: ${missing.join(", ")}`);
}
