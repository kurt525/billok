export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-dvh min-w-0 items-start justify-center overflow-x-clip bg-muted/50 px-4 py-6 sm:items-center">
      {/* Radial gradient glow behind the card */}
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden="true"
        style={{
          background: 'radial-gradient(ellipse 60% 50% at 50% 40%, var(--primary) 0%, transparent 70%)',
          opacity: 0.07,
        }}
      />
      <div className="relative w-full max-w-md">{children}</div>
    </div>
  );
}
