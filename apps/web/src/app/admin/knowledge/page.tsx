import { redirect } from 'next/navigation'

/** Knowledge is part of the top-level Resources area now. */
export default function OldKnowledgePage() {
  redirect('/resources')
}
