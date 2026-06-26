/** U10 / R5 — ordered, plain-language setup instructions. */

export function SetupSteps({ steps }: { steps: string[] }): JSX.Element {
  return (
    <section className="card setup" aria-label="Setup steps">
      <h3>Setup steps</h3>
      <ol>
        {steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
    </section>
  );
}
