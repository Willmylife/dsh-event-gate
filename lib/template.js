/**
 * dsh-event-gate — prompt 模板渲染（无宿主依赖，可独立测试）。
 * `{{key}}` 从变量表替换；未知变量替换为空串。
 */

/**
 * Render a prompt template.
 * @param template - the rule's promptTemplate.
 * @param vars - flat variable map.
 * @returns the rendered prompt text.
 */
export function renderTemplate(template, vars) {
  return String(template).replace(/\{\{([\w.]+)\}\}/g, (_match, key) => {
    const value = vars[key];
    return value === undefined || value === null ? "" : String(value);
  });
}
