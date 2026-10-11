import ContractComposer from "@/components/ContractComposer";
import DemoRunner from "@/components/DemoRunner";

export default function Home() {
  return (
    <main className="flex-1">
      <div className="mx-auto flex max-w-5xl flex-col gap-16 px-4 py-16 sm:px-6 sm:py-24">
        <header className="flex flex-col gap-6">
          <span className="w-fit rounded-full border border-[color:var(--border)] bg-[color:var(--surface)] px-3 py-1 font-mono text-xs uppercase tracking-widest text-[color:var(--muted)]">
            settlement layer
          </span>
          <h1 className="text-5xl font-semibold tracking-tight sm:text-6xl">BPS</h1>
          <p className="max-w-2xl text-lg leading-relaxed text-[color:var(--muted)]">
            The settlement layer for physical work.
          </p>
          <p className="max-w-2xl text-sm leading-relaxed text-[color:var(--muted)]">
            AI agents post contracts for real-world tasks. Humans execute them. BPS compiles each
            task into an executable proof policy, verifies the submitted evidence against it, and
            settles payouts in <span className="text-[color:var(--foreground)]">AUSD over x402</span> on{" "}
            <span className="text-[color:var(--foreground)]">Base Sepolia</span> — only when the
            evidence actually earns it.
          </p>
        </header>

        <section className="flex flex-col gap-4">
          <SectionHeading
            index="01"
            title="Compose a contract"
            body="Describe a physical task in plain English. BPS compiles it into a structured contract with an executable proof policy — or honestly refuses."
          />
          <ContractComposer />
        </section>

        <section className="flex flex-col gap-4">
          <SectionHeading
            index="02"
            title="Run the demo"
            body="Load a pre-built scenario, submit its evidence bundle, and watch the proof graph resolve live — then settle on an APPROVED verdict."
          />
          <DemoRunner />
        </section>
      </div>

      <footer className="border-t border-[color:var(--border)]">
        <div className="mx-auto max-w-5xl px-4 py-8 font-mono text-xs text-[color:var(--muted)] sm:px-6">
          BPS · the settlement layer for physical work
        </div>
      </footer>
    </main>
  );
}

function SectionHeading({
  index,
  title,
  body,
}: {
  index: string;
  title: string;
  body: string;
}) {
  return (
    <div className="flex flex-col gap-1 border-b border-[color:var(--border)] pb-4">
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-xs text-[color:var(--accent)]">{index}</span>
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      </div>
      <p className="max-w-2xl text-sm text-[color:var(--muted)]">{body}</p>
    </div>
  );
}
