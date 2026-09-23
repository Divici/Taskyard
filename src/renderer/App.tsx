import { APP_NAME } from '@shared/app-info'

export default function App(): React.JSX.Element {
  return (
    <main className="flex h-screen flex-col items-center justify-center gap-2 bg-background text-foreground select-none">
      <h1 className="text-3xl font-semibold tracking-tight">{APP_NAME}</h1>
      <p className="text-sm text-muted-foreground">Your desktop, organized.</p>
    </main>
  )
}
