import assert from 'node:assert/strict'
import { readPage, type SeeingModel } from '../src/lib/page-reading'
import { echoOfAgent } from '../src/lib/call-echo'

/**
 * The perception contract: whatever a page is made of, asking to look at it
 * returns what is on it. Every case here is a real call that went wrong before
 * the routes were collapsed into one ability.
 *
 * `readWebpage` is the only thing these cannot fake — it reaches the network —
 * so each case uses a URL that cannot resolve, which makes the fetch fail fast
 * and puts the interesting routes under test. The fetch-answers case is proved
 * by the browser never being asked.
 */

const page = (text: string, extra: Record<string, unknown> = {}) => ({
  url: 'https://example.invalid/menu',
  title: 'Menu',
  text,
  ...extra,
})

const seeingModel = (answer: string, onCall?: () => void): SeeingModel => ({
  describe: async () => {
    onCall?.()
    return answer
  },
})

// --- a page with real text is read where it is found ------------------------
{
  let visits = 0
  const reading = await readPage({
    url: 'https://nothing-here.invalid/article',
    visit: async () => {
      visits += 1
      return page('x'.repeat(400))
    },
    seeing: null,
  })
  assert.equal(reading.route, 'visited')
  assert.equal(visits, 1, 'the browser is asked exactly once')
  assert.ok(reading.text.length >= 200)
}

// --- the menu that is a photograph -----------------------------------------
// The failure this contract exists for: the fetch returns nothing because the
// page is images, the browser returns nothing for the same reason, and the
// caller sits watching that menu on their own screen being told "still
// looking". A model that can see reads it out instead.
{
  let described = 0
  const reading = await readPage({
    url: 'https://nothing-here.invalid/menu',
    visit: async () => page('', { screenshot: { mediaType: 'image/jpeg', data: 'AAAA', label: 'the page' } }),
    seeing: seeingModel('Sharables: dill pickle fries, poutine, mozzarella sticks.', () => {
      described += 1
    }),
  })
  assert.equal(reading.route, 'described')
  assert.equal(described, 1)
  assert.match(reading.text, /pickle fries/)
  assert.equal(reading.unreadable, undefined, 'a page that was read is not reported unreadable')
}

// --- nothing connected can see ---------------------------------------------
// Then the contract does not pretend. It says so, so the guarantee upstream —
// never describe a screen you cannot see — has something true to stand on.
{
  const reading = await readPage({
    url: 'https://nothing-here.invalid/menu',
    visit: async () => page('', { screenshot: { mediaType: 'image/jpeg', data: 'AAAA', label: 'the page' } }),
    seeing: null,
  })
  assert.equal(reading.route, 'visited')
  assert.ok(reading.unreadable, 'a page nothing could read says so')
  assert.match(reading.unreadable!, /look at a picture/)
}

// --- a describing model that fails is an enrichment, not the step ----------
{
  const reading = await readPage({
    url: 'https://nothing-here.invalid/menu',
    visit: async () => page('a short line', { screenshot: { mediaType: 'image/jpeg', data: 'AAAA', label: 'the page' } }),
    seeing: { describe: async () => Promise.reject(new Error('vision provider is down')) },
  })
  assert.equal(reading.route, 'visited')
  assert.equal(reading.text, 'a short line', 'whatever the page did give survives')
  assert.ok(reading.unreadable)
}

// --- no browser on this call -----------------------------------------------
// The regression that left an agent whose dial parks the browser unable to
// read anything at all: it must still get an answer, and an honest one.
{
  const reading = await readPage({ url: 'https://nothing-here.invalid/x', visit: null, seeing: null })
  assert.equal(reading.route, 'fetched')
  assert.ok(reading.unreadable, 'with no browser and no fetch, the page is reported unreadable')
  assert.equal(reading.text, '')
}

console.log('page reading: fetched, visited, described, and honest when nothing could read it')

// --- the agent hearing itself ----------------------------------------------
// A caller turn once read "What dates are you needing? Tomorrow." — the first
// half being the agent's own question, transcribed as the caller. It asked for
// dates twice and the caller swore at it.
{
  const asked = 'What dates are you needing?'
  assert.equal(echoOfAgent('What dates are you needing?', asked), true, 'its own words coming back are not a turn')
  assert.equal(echoOfAgent('what dates are you needing', asked), true, 'punctuation and case are not a difference')
  assert.equal(
    echoOfAgent('Tomorrow night if you can', asked),
    false,
    'a real answer to the question is a real turn',
  )
  assert.equal(
    echoOfAgent('You asked what dates I need and I said tomorrow', asked),
    false,
    'a caller quoting the agent back is still the caller speaking',
  )
  assert.equal(echoOfAgent('yes', 'yes'), false, 'too short to judge — a person agreeing is not an echo')
  assert.equal(echoOfAgent('anything at all', null), false, 'nothing said yet cannot be echoed')
  // The Marla call: the agent's "I am on it, Braedon. I" came back transcribed
  // as "I'm on it." — a contraction is not a difference.
  assert.equal(
    echoOfAgent("I'm on it.", 'I am on it, Braedon. I'),
    true,
    'STT contracting the agent`s own words is still an echo',
  )
  assert.equal(
    echoOfAgent('I am digging right into those', "I'm digging right into those figures now"),
    true,
    'the expansion works in both directions',
  )
  // Echo arrives late: the line it echoes may be an utterance or two back.
  assert.equal(
    echoOfAgent('what dates are you needing', ['Tomorrow works for me.', asked]),
    true,
    'an echo of the line before last is still an echo',
  )
  assert.equal(
    echoOfAgent("I'm leaving now", 'I am on it, Braedon. I'),
    false,
    'a real caller sentence sharing a couple of words is a real turn',
  )
  console.log('echo: the agent hearing itself is not a caller turn')
}

// --- a handoff that has gone round too many times ---------------------------
// Two agents being helpful at each other is a loop that spends real money, and
// the chain has to carry its own length or nothing can see it. Pure, so it is
// tested without a database.
{
  const { hopsOf } = await import('../src/lib/colleague-post')
  assert.equal(hopsOf(null), 0, 'nothing has been handed over yet')
  assert.equal(hopsOf({ kind: 'call', sessionId: 'x' }), 0, 'work that came off a call starts no chain')
  assert.equal(
    hopsOf({ kind: 'delegation', fromPersonId: 'a', runId: 'r' }),
    1,
    'a delegation from before the count existed is one hop, not zero — it must not restart the chain',
  )
  assert.equal(hopsOf({ kind: 'delegation', fromPersonId: 'a', runId: 'r', hops: 3 }), 3)
  console.log('handoff: a chain between colleagues knows how long it is')
}

// --- a belief the ledger disagrees with -------------------------------------
// Real notes, verbatim from the logbooks that produced the overnight bill.
{
  const { toolsClaimedBroken, ledgeredSuccess } = await import('../src/lib/stale-beliefs')
  const known = new Set(['run_shell', 'run_script', 'email_colleague', 'ask_and_wait', 'web_search'])

  assert.deepEqual(
    toolsClaimedBroken('`run_shell` fails with "bwrap: No permissions to create new namespace" — use run_script', known),
    ['run_shell', 'run_script'],
    'every tool the claim touches is checked, because either working disproves it',
  )
  assert.deepEqual(
    toolsClaimedBroken('Both `ask_and_wait` and `email_colleague` return "No mailbox connected".', known),
    ['ask_and_wait', 'email_colleague'],
  )
  // The line this guard exists for: a note that MENTIONS a tool is a record of
  // work, and retiring it would throw away real history.
  assert.deepEqual(
    toolsClaimedBroken('Used run_shell to tidy the export folder; took two minutes.', known),
    [],
    'mentioning a tool is not claiming it is broken',
  )
  assert.deepEqual(toolsClaimedBroken('The customer cannot be reached by phone.', known), [], 'no tool, no claim')
  assert.deepEqual(
    toolsClaimedBroken('deploy_widget fails every time', known),
    [],
    'a name that is not one of our tools is not a claim about our tools',
  )

  assert.equal(ledgeredSuccess({ ok: true }), true)
  assert.equal(ledgeredSuccess({ error: 'No mailbox connected for this agent.' }), false)
  assert.equal(ledgeredSuccess({ status: 'pending_approval' }), false, 'parked is not proof it works')
  assert.equal(ledgeredSuccess({ status: 'forbidden' }), false)
  assert.equal(ledgeredSuccess({ sent: false, reason: 'not in the directory' }), false, 'a tool that says no in prose')
  assert.equal(ledgeredSuccess(null), false)
  console.log('beliefs: a note claiming a tool is broken is checked against the ledger, not re-read')
}

// --- nobody hangs up without saying something -------------------------------
{
  const { soundsLikeGoodbye } = await import('../src/lib/call-echo')
  for (const farewell of [
    'Alright, take care Bill.',
    'Thanks for calling — bye now.',
    'Have a good one!',
    'I will send that over. Speak soon.',
    'Great, see you Thursday.',
    'You too, cheers.',
  ]) {
    assert.equal(soundsLikeGoodbye(farewell), true, `"${farewell}" is a goodbye`)
  }
  // The line the caller experiences as a dropped call: a complete, helpful
  // answer, and then silence.
  assert.equal(
    soundsLikeGoodbye('They open at nine tomorrow and the manager is called Rita.'),
    false,
    'answering the question is not signing off',
  )
  assert.equal(soundsLikeGoodbye('Sure, one moment.'), false)
  assert.equal(soundsLikeGoodbye(null), false, 'having said nothing at all is not a goodbye')
  console.log('goodbye: the line does not just go dead')
}

// --- an endpoint a strict server will accept --------------------------------
// Every call recording failed to upload with MinIO answering "invalid
// hostname". Not credentials, not the bucket — the Host header. Container
// service names carry an underscore, which is illegal in a hostname.
{
  const { legalHostname, addressableEndpoint } = await import('../src/lib/voice-recording')
  assert.equal(legalHostname('minio.example.com'), true)
  assert.equal(legalHostname('10.0.0.101'), true, 'an address is always spellable')
  assert.equal(legalHostname('minio'), true, 'a single label is fine on its own')
  assert.equal(
    legalHostname('compose-compress-haptic-transmitter-po6zer_minio'),
    false,
    'the underscore is the whole bug',
  )

  // A legal endpoint is never touched — a deployment on a real domain must not
  // have its address quietly swapped for an IP.
  assert.deepEqual(await addressableEndpoint('https://storage.example.com'), {
    endpoint: 'https://storage.example.com',
  })
  // The failure itself: an unspellable name that DOES resolve is swapped for
  // its address, port and scheme and path intact.
  const rewritten = await addressableEndpoint('http://stack_minio:9000', async () => '10.0.0.7')
  assert.equal(rewritten.endpoint, 'http://10.0.0.7:9000', 'the address replaces the name it could not spell')
  assert.match(rewritten.note ?? '', /Host header/)
  // A legal name is never resolved at all — no lookup, no substitution.
  let looked = 0
  await addressableEndpoint('https://storage.example.com', async () => {
    looked += 1
    return '1.2.3.4'
  })
  assert.equal(looked, 0, 'a legal endpoint is left completely alone')
  // Unresolvable and illegal: nothing better to offer, so it is handed back
  // unchanged rather than mangled into something that fails differently.
  assert.deepEqual(
    await addressableEndpoint('http://not_a_host.invalid:9000', async () => {
      throw new Error('NXDOMAIN')
    }),
    { endpoint: 'http://not_a_host.invalid:9000' },
  )
  assert.deepEqual(await addressableEndpoint('not a url at all'), { endpoint: 'not a url at all' })
  console.log('recording: the store is addressed by something a strict server accepts')
}

// --- what the privileged runner will and will not be talked into ------------
// The shell sandbox runs in a container with CAP_SYS_ADMIN and both seccomp
// and AppArmor unconfined, because bubblewrap needs all three. It is handed a
// home directory and makes it writable, so the one thing standing between a
// bad request and the host filesystem is this check.
{
  const { insideRoot } = await import('../src/lib/shell-sandbox')
  const root = '/data/agent-homes'
  assert.equal(insideRoot(root, '/data/agent-homes/tenant/person'), true)
  assert.equal(insideRoot(root, root), true, 'the root itself is inside itself')
  assert.equal(insideRoot(root, '/etc'), false)
  assert.equal(insideRoot(root, '/'), false, 'the whole filesystem is the request to refuse')
  // A prefix is not a parent. Without the separator check this reads as inside.
  assert.equal(insideRoot(root, '/data/agent-homes-evil/x'), false, 'a shared prefix is not containment')
  // Traversal, resolved before comparing rather than pattern-matched.
  assert.equal(insideRoot(root, '/data/agent-homes/../../etc/shadow'), false, 'dot-dot does not escape')
  assert.equal(insideRoot(root, '/data/agent-homes/a/../b'), true, 'traversal that stays inside is still inside')
  console.log('shell: the privileged runner refuses to make anything but a home writable')
}

// --- which dial governs an email --------------------------------------------
// Ten runs sat parked for hours awaiting sign-off to send mail to
// dana@bunkhouse.local — a colleague — because send_email carried
// 'external_email' whatever the address was, while the identical message
// through email_colleague went straight out on the internal dial. Same action,
// two answers, decided by which tool the model reached for.
{
  const { governedToolSet } = await import('@bunkhouse/runtime')
  const { defineAbility } = await import('@bunkhouse/runtime')
  const { z } = await import('zod')

  const asked: string[] = []
  const ability = defineAbility({
    name: 'send_email',
    description: 'send',
    category: (input: { to: string }) => (input.to.endsWith('@bunkhouse.local') ? 'internal_email' : 'external_email'),
    inputSchema: z.object({ to: z.string() }),
    execute: async () => ({ sent: true }),
  })
  const tools = governedToolSet({
    abilities: [ability],
    autonomy: (category) => {
      asked.push(category)
      return category === 'internal_email' ? 'trusted' : 'approval'
    },
    approvals: { request: async () => ({ approvalId: 'ap-1' }) },
    sink: { event: async () => {}, spend: async () => {} },
    state: { pendingApprovalId: null, pendingWait: null },
  })
  const run = (to: string) => tools.send_email!.execute!({ to }, { toolCallId: 't', messages: [] })

  const colleague = (await run('dana@bunkhouse.local')) as Record<string, unknown>
  assert.equal(asked.at(-1), 'internal_email', 'a colleague is governed by the internal dial')
  assert.equal(colleague.sent, true, 'and goes straight through')

  const outsider = (await run('someone@example.com')) as Record<string, unknown>
  assert.equal(asked.at(-1), 'external_email', 'an outside address is still external')
  assert.equal(outsider.status, 'pending_approval', 'and still waits for a person')
  console.log('governance: the dial follows what is being asked for, not the tool that asks')
}

// --- what one ask is allowed to cost ----------------------------------------
// Four test phone calls — four runs, twenty cents — became 913 assignments and
// fifty-three dollars, and nothing noticed but the invoice. The salary meter
// would not have caught it: it bounds an agent's month, not a request.
{
  const { MAX_SPEND_PER_ROOT_USD, MAX_DERIVED_RUNS_PER_ROOT, MAX_SELF_DIRECTED_USD_PER_DAY } = await import(
    '../src/lib/work-budget'
  )
  assert.ok(MAX_SPEND_PER_ROOT_USD > 0 && MAX_SPEND_PER_ROOT_USD <= 10, 'a single ask has a small, real ceiling')
  assert.ok(
    MAX_DERIVED_RUNS_PER_ROOT < 913,
    'and a count low enough that the afternoon which caused this would have been stopped',
  )
  // The one that actually happened: a broken mailbox an agent decided to fix
  // itself, a day of NetSuite queries, every run its own root so no per-ask
  // ceiling ever applied.
  assert.ok(
    MAX_SELF_DIRECTED_USD_PER_DAY > 0 && MAX_SELF_DIRECTED_USD_PER_DAY < MAX_SPEND_PER_ROOT_USD,
    'work nobody asked for gets a smaller allowance than work somebody did',
  )
  console.log(
    `provenance: one ask may spend $${MAX_SPEND_PER_ROOT_USD} across ${MAX_DERIVED_RUNS_PER_ROOT} runs; unasked work $${MAX_SELF_DIRECTED_USD_PER_DAY}/day`,
  )
}

// --- who is where, and does it hold still ------------------------------------
// The floor re-renders constantly. A whereabouts that rolled dice per render
// would teleport the whole company several times a second — the jumping-
// characters bug, but continuous. So it is a pure function of who, when, and
// where they might go.
{
  const { whereaboutsOf, peopleInDepartment, WANDER_SLOT_MINUTES } = await import('../src/lib/whereabouts')
  const departments = ['floor', 'exec', 'warehouse', 'roof']
  const at = (iso: string) => new Date(iso)

  // Same person, same slot, called a hundred times: the same answer every time.
  const answers = new Set(
    Array.from({ length: 100 }, () =>
      JSON.stringify(
        whereaboutsOf({
          personId: 'bill',
          homeId: 'floor',
          departmentIds: departments,
          now: at('2026-07-31T09:03:00Z'),
          wander: true,
        }),
      ),
    ),
  )
  assert.equal(answers.size, 1, 'the same moment always gives the same answer')

  // And still the same a few seconds later, inside the same slot.
  assert.deepEqual(
    whereaboutsOf({ personId: 'bill', homeId: 'floor', departmentIds: departments, now: at('2026-07-31T09:03:00Z'), wander: true }),
    whereaboutsOf({ personId: 'bill', homeId: 'floor', departmentIds: departments, now: at('2026-07-31T09:06:59Z'), wander: true }),
    'nobody moves mid-slot',
  )

  // Turned off, everybody is at their own desk, always.
  for (const hour of ['00', '06', '13', '21']) {
    const still = whereaboutsOf({
      personId: 'dana',
      homeId: 'exec',
      departmentIds: departments,
      now: at(`2026-07-31T${hour}:00:00Z`),
      wander: false,
    })
    assert.deepEqual(still, { departmentId: 'exec', visiting: false }, 'wandering off means nobody wanders')
  }

  // Somebody with no desk is shown wherever you are looking, rather than
  // vanishing from every floor — which would read as a bug, not a person.
  const nomad = peopleInDepartment({
    people: [{ id: 'x', departmentId: null }],
    departmentId: 'warehouse',
    departmentIds: departments,
    now: at('2026-07-31T09:03:00Z'),
    wander: true,
  })
  assert.equal(nomad.length, 1, 'no desk means everywhere, not nowhere')

  // Over a working day somebody does actually move, and never to their own desk
  // when they do — otherwise "visiting" would be a lie.
  const slots = Array.from({ length: Math.floor((8 * 60) / WANDER_SLOT_MINUTES) }, (_, i) =>
    whereaboutsOf({
      personId: 'jimmy',
      homeId: 'floor',
      departmentIds: departments,
      now: new Date(Date.UTC(2026, 6, 31, 9, i * WANDER_SLOT_MINUTES)),
      wander: true,
    }),
  )
  const away = slots.filter((s) => s.visiting)
  assert.ok(away.length > 0, 'somebody leaves their desk at some point in a day')
  assert.ok(away.length < slots.length / 2, 'but they are mostly where they belong')
  assert.ok(
    away.every((s) => s.departmentId !== 'floor'),
    'visiting always means somewhere that is not home',
  )
  console.log(`whereabouts: stable within a ${WANDER_SLOT_MINUTES}-minute slot, ${away.length}/${slots.length} slots away`)
}

// --- a backdrop a model drew cannot run anything -----------------------------
{
  const { sanitiseSceneSvg } = await import('../src/lib/scene-svg')
  const ok = sanitiseSceneSvg('<svg viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="8" fill="#333"/></svg>')
  assert.ok('svg' in ok && ok.svg, 'an ordinary drawing survives')
  assert.match(ok.svg!, /<rect/)

  const attacks: [string, string][] = [
    ['script tag', '<svg><script>alert(1)</script><rect width="4" height="4"/></svg>'],
    ['event handler', '<svg><rect width="4" height="4" onload="alert(1)"/></svg>'],
    ['foreignObject', '<svg><foreignObject><body onload="alert(1)"/></foreignObject><rect width="4" height="4"/></svg>'],
    ['javascript href', '<svg><a href="javascript:alert(1)"><rect width="4" height="4"/></a></svg>'],
    ['remote image', '<svg><image href="https://evil.example/x.svg"/><rect width="4" height="4"/></svg>'],
    ['style import', '<svg><rect width="4" height="4" style="background:url(https://evil.example/x)"/></svg>'],
    ['comment smuggling', '<svg><!--<script>alert(1)</script>--><rect width="4" height="4"/></svg>'],
  ]
  for (const [name, attack] of attacks) {
    const cleaned = sanitiseSceneSvg(attack)
    const out = 'svg' in cleaned && cleaned.svg ? cleaned.svg : ''
    assert.doesNotMatch(out, /<script|onload|foreignObject|javascript:|evil\.example/i, `${name} does not survive`)
  }
  assert.ok('reason' in sanitiseSceneSvg('just some prose'), 'prose is not a drawing')
  console.log('backdrop: a model drawing cannot carry anything that runs')
}

// --- the bright room is the SAME room --------------------------------------
{
  const { toLightBackdrop } = await import('../src/lib/scene-recolour')
  const { DEFAULT_PALETTE } = await import('../src/lib/scene-palette')

  const dark = [
    '<svg viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice">',
    '<rect x="0" y="0" width="1600" height="468" fill="#0b1220"/>',
    '<rect x="0" y="468" width="1600" height="432" fill="#1a2740"/>',
    '<path d="M100 200 L300 200 L300 400 Z" fill="#24344f" stroke="#33455f"/>',
    '<rect x="420" y="180" width="160" height="90" fill="#8FC7F0"/>',
    '<circle cx="1500" cy="120" r="18" fill="#f5a623"/>',
    '<rect x="900" y="200" width="40" height="40" fill="#2b1a06" class="black-panel"/>',
    '<rect x="960" y="200" width="40" height="40" fill="black" stroke="none"/>',
    '</svg>',
  ].join('')
  const light = toLightBackdrop(dark)

  // Every shape, in order, with every geometry attribute untouched. This is the
  // whole point: a theme switch should turn the lights on, not rearrange the
  // furniture, which is exactly what drawing it twice did.
  const shapesOf = (svg: string) =>
    (svg.match(/<(rect|path|circle|ellipse|polygon|line)\b[^>]*>/g) ?? []).map((tag) =>
      tag.replace(/\s(fill|stroke|stop-color)\s*=\s*"[^"]*"/g, ''),
    )
  assert.deepEqual(shapesOf(light), shapesOf(dark), 'the geometry is identical, only colour moves')

  // The palette colours map exactly...
  assert.ok(light.includes(DEFAULT_PALETTE.light.colours[0]!), 'the darkest structure colour became the lightest')
  assert.ok(light.includes(DEFAULT_PALETTE.light.colours[2]!), 'mid structure mapped too')
  assert.ok(!/#0b1220|#1a2740|#24344f|#33455f/i.test(light), 'no dim structure colour survives')
  assert.ok(light.includes(DEFAULT_PALETTE.light.lit), 'the lit colour became its bright-room equivalent')
  // ...case-insensitively, because models shout their hex.
  assert.ok(!/#8fc7f0/i.test(light), 'an uppercase hex is recoloured like any other')
  // The accent is the brand amber and is deliberately the one colour that does
  // not move between themes.
  assert.ok(light.includes(DEFAULT_PALETTE.dark.accent), 'the accent is untouched')

  // Anything off-palette still has to stop being dark, or it is a smudge on a
  // pale wall.
  const stray = light.match(/fill="(#[0-9a-f]{6})" class="black-panel"/i)?.[1]
  assert.ok(stray, 'the off-palette shape kept its class and its shape')
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  }
  assert.ok(luminance(stray!) > 0.6, `an off-palette dark colour is flipped light, got ${stray}`)
  assert.ok(luminance(DEFAULT_PALETTE.dark.colours[0]!) < 0.2, 'and it really was dark to begin with')

  // A colour word in an attribute is a colour; the same word in a class is not.
  assert.ok(/stroke="none"/.test(light), 'none is not a colour and is left alone')
  assert.ok(/class="black-panel"/.test(light), 'a class that reads like a colour is not a colour')
  assert.ok(!/fill="black"/.test(light), 'a named fill is recoloured')

  console.log('backdrop: the bright room is the dim room with the lights on')
}

// --- every revalidated path is a real page ----------------------------------
//
// Departments moved under company settings, but every one of their actions
// went on revalidating `/organization/departments` — a route that no longer
// existed. Next does not complain about that; it just quietly refreshes
// nothing. So saving a backdrop wrote the new drawing to the database and left
// the open drawer rendering the old one, and it looked for all the world like
// the save had failed.
//
// A path that resolves to no route is always a mistake, and it is invisible at
// runtime, which is exactly the sort of thing a test should be holding.
{
  const { readdirSync, readFileSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next') continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full, out)
      else out.push(full)
    }
    return out
  }

  const files = walk('src')

  // Routes, from the files that define them. A `(group)` segment is an
  // organisational folder and does not appear in the URL.
  const routes = new Set(
    files
      .filter((f) => /[\\/](page|route)\.tsx?$/.test(f))
      .map(
        (f) =>
          '/' +
          f
            .replace(/^src[\\/]app[\\/]?/, '')
            .replace(/[\\/]?(page|route)\.tsx?$/, '')
            .split(/[\\/]/)
            .filter((s) => s && !/^\(.*\)$/.test(s))
            .join('/'),
      ),
  )
  assert.ok(routes.has('/'), 'the home page is a route')
  assert.ok(routes.has('/admin/settings'), 'company settings is a route')
  assert.ok(!routes.has('/organization/departments'), 'and departments is not one any more')

  // An EXACT match against a static route, deliberately. Letting `[param]`
  // stand in for anything is not merely lax, it is the thing that hid the bug:
  // `/organization/departments` happily matches `/organization/[id]`, so a
  // path aimed at a page that no longer exists looks resolvable while actually
  // revalidating one person's record with "departments" as their id. Nothing
  // in this app revalidates a dynamic route by literal id; if something ever
  // needs to, this should fail and be thought about rather than wave it past.
  const dynamic = new Set([...routes].filter((route) => route.includes('[')))
  const resolves = (path: string) => routes.has(path) && !dynamic.has(path)

  const dead: string[] = []
  const opaque: string[] = []
  let checked = 0
  for (const file of files.filter((f) => /\.tsx?$/.test(f))) {
    const source = readFileSync(file, 'utf8')
    // Several of these files name their page in a `const` and pass that. The
    // first version of this test only read string literals, so those calls
    // were invisible to it — and three of the four dead paths in the codebase
    // were hiding behind exactly such a constant. Following them is the
    // difference between this test working and only appearing to.
    const consts = new Map(
      [...source.matchAll(/^const\s+([A-Z][A-Z0-9_]*)\s*=\s*'([^']+)'/gm)].map(([, name, value]) => [name!, value!]),
    )
    for (const [, argument] of source.matchAll(/revalidatePath\(\s*([^,)]+?)\s*[,)]/g)) {
      checked += 1
      const literal = /^'([^']+)'$/.exec(argument!)?.[1] ?? consts.get(argument!)
      // Anything this cannot read is reported rather than skipped. A silent
      // skip is how the gap got in.
      if (literal === undefined) opaque.push(`${file}: ${argument}`)
      else if (!resolves(literal)) dead.push(`${file}: ${argument} → ${literal}`)
    }
  }

  assert.ok(checked > 100, `found revalidatePath calls to check, got ${checked}`)
  assert.deepEqual(opaque, [], `every revalidated path can be read statically:\n  ${opaque.join('\n  ')}`)
  assert.deepEqual(dead, [], `every revalidated path resolves to a page:\n  ${dead.join('\n  ')}`)
  console.log(`revalidation: all ${checked} revalidated paths resolve to a real page`)
}
