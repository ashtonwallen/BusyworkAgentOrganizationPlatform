import { objectiveTitle } from '../lib/record-display.js';
import { state, employeeName, ACTIVE_TASK } from '../lib/state.js';
import { esc, money, micro, until, date, badge, titleCase, truncate } from '../lib/format.js';
import { icon } from '../lib/icons.js';
import { empty } from '../lib/ui.js';

/**
 * Builds a hierarchical tree representation of objectives and delegated sub-tasks.
 */
export function taskTree(tasks) {
  if (!tasks.length) {
    return empty('No work yet', 'The CEO creates and delegates objectives once the company is running.', '', 'work');
  }

  // Find root tasks (tasks with no parent_id or whose parent_id is not in the list)
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const roots = tasks.filter((t) => !t.parent_id || !taskMap.has(t.parent_id));

  // If no clear roots, fallback to all tasks sorted by depth
  const rootList = roots.length ? roots : tasks.filter((t) => t.depth === 0);

  function renderNode(task, depth = 0) {
    const person = task.employee_id ? employeeName(task.employee_id) : null;
    const spend = Number(task.spentUsd) || 0;
    const budget = Number(task.budgetUsd) || 0;
    const children = tasks.filter((t) => t.parent_id === task.id);
    const hasChildren = children.length > 0;

    return `
      <div class="tree-node depth-${Math.min(depth, 4)}" style="--depth: ${depth};">
        <div class="tree-row">
          <div class="tree-branch-indicator">
            ${depth > 0 ? '<span class="tree-line"></span>' : ''}
            <span class="tree-bullet ${hasChildren ? 'has-kids' : ''}">${hasChildren ? icon('arrow') : '•'}</span>
          </div>
          <div class="tree-content">
            <div class="tree-main">
              <button class="table-link tree-title" data-task="${task.id}">
                ${truncate(objectiveTitle(task), 90)}
              </button>
              <div class="row-detail">
                ${person ? `<strong>${esc(person)}</strong> · ` : ''}
                <span>${esc(task.role)}</span>
                ${task.model_id ? ` · <span class="muted">${esc(task.model_id)}</span>` : ''}
                ${task.phase && ACTIVE_TASK(task) ? ` · <span class="chip-phase">${esc(titleCase(task.phase))}</span>` : ''}
              </div>
            </div>
            <div class="tree-meta">
              ${badge(task.status)}
              <div class="tree-spend">
                <strong>${money(spend, spend < 1 ? 4 : 2)}</strong>
                <span class="muted">/ ${money(budget)}</span>
              </div>
              <div class="tree-time muted">
                ${ACTIVE_TASK(task) ? `${until(task.expires_at)} left` : date(task.created_at)}
              </div>
            </div>
          </div>
        </div>
        ${hasChildren ? `<div class="tree-children">${children.map((c) => renderNode(c, depth + 1)).join('')}</div>` : ''}
      </div>
    `;
  }

  return `<div class="work-tree">${rootList.map((r) => renderNode(r, 0)).join('')}</div>`;
}
