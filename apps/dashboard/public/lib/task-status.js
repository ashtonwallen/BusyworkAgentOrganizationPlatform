import { state } from './state.js';

export function modelLabel(id) {
  const model = (state.data?.models || []).find(m => m.id === id);
  return model?.model ? `${model.name} (${model.model})` : id;
}

/** Keep the original diagnostic, but identify which side of the assignment failed. */
export function taskProblem(task) {
  if (!task.error) return '';
  const review = task.phase === 'REVIEW';
  const id = task.model_id;
  if (task.error.startsWith('Model context is too small')) {
    return `${review ? 'Self-check' : 'Worker'} context limit: ${modelLabel(id)}. ${task.error}`;
  }
  return task.error;
}
