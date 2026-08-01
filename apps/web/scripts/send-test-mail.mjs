// Dev-only: inject inbound mail into the local greenmail lab so an agent's
// real receive path (IMAP sync → inbound run) can be exercised end to end.
// Usage: node send-test-mail.mjs <from> <to> <subject> <body-file>
import net from 'node:net'

const [from, to, subject, bodyFile] = process.argv.slice(2)
if (!from || !to || !subject || !bodyFile) {
  throw new Error('usage: send-test-mail.mjs <from> <to> <subject> <body-file>')
}
const body = await import('node:fs/promises').then((fs) => fs.readFile(bodyFile, 'utf8'))

const socket = net.createConnection({ host: '127.0.0.1', port: 3025 })
socket.setEncoding('utf8')

const say = (line) =>
  new Promise((resolve, reject) => {
    const onData = (chunk) => {
      socket.off('data', onData)
      if (/^[45]/.test(chunk)) reject(new Error(`SMTP refused: ${chunk.trim()}`))
      else resolve(chunk)
    }
    socket.on('data', onData)
    socket.on('error', reject)
    if (line !== null) socket.write(`${line}\r\n`)
  })

const message = [
  `From: ${from}`,
  `To: ${to}`,
  `Subject: ${subject}`,
  `Date: ${new Date().toUTCString()}`,
  `Message-ID: <${Math.floor(performance.now() * 1000)}.test@bunkhouse.local>`,
  'Content-Type: text/plain; charset=utf-8',
  '',
  body.trimEnd(),
  '.',
].join('\r\n')

await say(null) // greeting
await say('EHLO bunkhouse-test')
await say(`MAIL FROM:<${from.replace(/.*</, '').replace(/>.*/, '') || from}>`)
await say(`RCPT TO:<${to}>`)
await say('DATA')
await say(message)
await say('QUIT')
socket.end()
console.log(`sent: ${subject} → ${to}`)
