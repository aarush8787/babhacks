const features = [
  {
    title: "Next.js App Router",
    body: "Server components, streaming, and file-based routing on Next.js 16.",
  },
  {
    title: "Tailwind CSS v4",
    body: "Utility-first styling with CSS-native theming and zero config.",
  },
  {
    title: "Deployed on Vercel",
    body: "Every push to main ships a production build automatically.",
  },
];

export default function Home() {
  return (
    <main className="flex-1">
      <div className="mx-auto flex max-w-3xl flex-col gap-16 px-6 py-20 sm:py-28">
        <header className="flex flex-col gap-6">
          <span className="w-fit rounded-full border border-border bg-surface px-3 py-1 font-mono text-xs tracking-widest text-muted uppercase">
            babhacks
          </span>
          <h1 className="text-5xl font-semibold tracking-tight sm:text-6xl">
            BSA
          </h1>
          <p className="max-w-xl text-lg leading-relaxed text-muted">
            A starting point built with React, Next.js, and Tailwind CSS. Edit{" "}
            <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-[0.9em] text-foreground">
              src/app/page.tsx
            </code>{" "}
            to make it yours.
          </p>
          <div className="flex flex-wrap gap-3">
            <a
              href="https://github.com/aarush8787/babhacks"
              className="rounded-lg bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-85"
            >
              View on GitHub
            </a>
            <a
              href="https://nextjs.org/docs"
              className="rounded-lg border border-border px-5 py-2.5 text-sm font-medium transition-colors hover:bg-surface"
            >
              Read the docs
            </a>
          </div>
        </header>

        <section className="grid gap-4 sm:grid-cols-3">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="rounded-xl border border-border bg-surface p-5"
            >
              <h2 className="text-sm font-semibold">{feature.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                {feature.body}
              </p>
            </div>
          ))}
        </section>
      </div>

      <footer className="border-t border-border">
        <div className="mx-auto max-w-3xl px-6 py-8 font-mono text-xs text-muted">
          BSA · babhacks
        </div>
      </footer>
    </main>
  );
}
