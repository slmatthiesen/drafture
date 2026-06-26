/** U10 / R7 — the tier's safe-by-default security posture. */

export function SecurityPanel({ notes }: { notes: string[] }): JSX.Element {
  return (
    <section className="card security" aria-label="Security posture">
      <h3>Security</h3>
      {notes.length === 0 ? (
        <p>No security notes provided.</p>
      ) : (
        <ul>
          {notes.map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
