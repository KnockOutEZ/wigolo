import { useState } from 'preact/hooks';
import { useCommentsSnapshot, type CommentsModel } from '../transport/comments.js';
import { up, encodeUp } from '../transport/codec.js';
import { SafeText } from './SafeText.js';

/**
 * The comments/annotations panel (7b-notes S3) — the human's annotate-and-read surface. The input emits a
 * {t:'comment', text} up-message THROUGH THE CODEC and clears; it does nothing else (no optimistic local add).
 * The list MIRRORS the SERVER-authoritative CommentsModel (post-hello snapshot + live echo delta) — a row
 * appears ONLY when the host echoes a captured comment back, so a comment the human sees is always a comment
 * that was actually captured. Each comment is page/host-relayed text rendered via SafeText (inert) so a comment
 * carrying markup can never inject. Copy is capability language only.
 */
export interface CommentsPanelProps {
  model: CommentsModel;
  /** Send an encoded up-message to the host (real: StreamConnection.send via the rail's one codec emit). */
  emit: (wire: string) => void;
}

export function CommentsPanel({ model, emit }: CommentsPanelProps) {
  const comments = useCommentsSnapshot(model);
  const [text, setText] = useState('');
  const submit = (e: Event) => {
    e.preventDefault(); // never let the browser perform a native form submit
    const t = text.trim();
    if (!t) return;
    emit(encodeUp(up.comment(t))); // emit only — the comment shows when the host echoes it back (no optimistic add)
    setText('');
  };
  return (
    <section class="studio-comments" aria-label="Comments">
      <h2>Comments</h2>
      <form class="studio-comment-form" onSubmit={submit}>
        <input
          class="studio-comment-input"
          type="text"
          value={text}
          onInput={(e) => setText((e.target as HTMLInputElement).value)}
          aria-label="Add a comment"
          placeholder="Add a comment"
        />
        <button type="submit" class="studio-comment-add">
          Add
        </button>
      </form>
      {comments.length === 0 ? (
        <p class="studio-comments-empty">No comments yet.</p>
      ) : (
        <ul class="studio-comments-list">
          {comments.map((c) => (
            <li key={c.id} class="studio-comment">
              <SafeText class="studio-comment-text" value={c.text} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
