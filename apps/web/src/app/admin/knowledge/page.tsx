import { redirect } from 'next/navigation'

/** Knowledge is a top-level area now. */
export default function OldKnowledgePage() {
  redirect('/knowledge')
}
