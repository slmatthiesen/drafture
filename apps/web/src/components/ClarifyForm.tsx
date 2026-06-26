/**
 * U10 / R2 — render the model's clarifying questions, collect answers, resubmit
 * (the parent advances the `round`). At most one or two rounds happen before the
 * backend forces generation, so this form just gathers free-text answers.
 */

import { useState } from "react";

export function ClarifyForm({
  questions,
  onSubmit,
  busy = false,
}: {
  questions: string[];
  onSubmit: (answers: string[]) => void;
  busy?: boolean;
}): JSX.Element {
  const [answers, setAnswers] = useState<string[]>(() => questions.map(() => ""));

  const update = (index: number, value: string): void => {
    setAnswers((prev) => prev.map((a, i) => (i === index ? value : a)));
  };

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    onSubmit(answers);
  };

  return (
    <form className="card clarify" onSubmit={handleSubmit} aria-label="Clarifying questions">
      <h2>A couple of quick questions</h2>
      <p className="clarify__hint">
        These materially change the architecture. Answer what you can — we'll proceed either way.
      </p>
      {questions.map((q, i) => (
        <label key={i} className="clarify__field">
          <span>{q}</span>
          <input
            type="text"
            value={answers[i] ?? ""}
            onChange={(e) => update(i, e.target.value)}
            disabled={busy}
          />
        </label>
      ))}
      <button type="submit" disabled={busy}>
        {busy ? "Designing…" : "Continue"}
      </button>
    </form>
  );
}
