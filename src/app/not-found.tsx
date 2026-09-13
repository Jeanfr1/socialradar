import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-[60vh] items-center justify-center px-4">
      <div className="max-w-md rounded-lg border border-line bg-surface p-6 text-center">
        <h1 className="text-lg font-semibold">Page not found</h1>
        <p className="mt-2 text-ink-2">This page doesn&apos;t exist, or you don&apos;t have access to it.</p>
        <p className="mt-4">
          <Link href="/portfolio" className="link">
            Go to Portfolio
          </Link>
        </p>
      </div>
    </main>
  );
}
