import { Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader } from '@appkit/ui'

export default function HomePage() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl space-y-6 p-4 sm:p-6 lg:p-8">
        <PageHeader title="Web" description="Your application foundation is ready." />
        <Card>
          <CardHeader>
            <CardTitle>Build the product</CardTitle>
            <CardDescription>AppKit supplies the shell, tokens, primitives, and optional platform packages.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-fg-muted">Replace this card with your first application workflow.</CardContent>
        </Card>
      </div>
    </div>
  )
}
