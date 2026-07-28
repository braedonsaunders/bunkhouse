import { redirect } from 'next/navigation'

/** Person records live in the directory drawer now; deep links land there. */
export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  redirect(`/people?person=${id}`)
}
