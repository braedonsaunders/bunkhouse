import { redirect } from 'next/navigation'

/** Procedures live under Resources now. */
export default function OldProceduresPage() {
  redirect('/resources?tab=procedures')
}
