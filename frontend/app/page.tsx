import { BatchUploader } from "../components/BatchUploader";

export default function HomePage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-semibold">Edición de video por lotes</h1>
      <p className="mt-2 text-sm text-zinc-400">
        Corta silencios con NVENC y quema los subtítulos con la plantilla elegida.
      </p>
      <BatchUploader />
    </main>
  );
}
