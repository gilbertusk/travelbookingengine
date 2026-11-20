// Menjadikan satu akun yang SUDAH terdaftar sebagai operator (Step 27).
//
//   DATABASE_URL=postgresql://... pnpm --filter @tbe/auth-service operator:grant budi@example.com
//   DATABASE_URL=postgresql://... pnpm --filter @tbe/auth-service operator:grant budi@example.com --revoke
//
// Kenapa skrip, bukan endpoint: endpoint "jadikan operator" adalah rute yang
// harus dilindungi peran operator — dan operator pertama tidak dapat lahir
// dari rute yang menuntut operator. Endpoint dengan rahasia bersama sebagai
// gantinya hanya memindahkan masalah ke rahasia itu. Skrip ini menuntut akses
// basis data auth-service, yang memang batas kepercayaan paling sempit yang
// sudah ada.
//
// Peran baru berlaku saat access token BERIKUTNYA terbit (masuk ulang atau
// refresh). Token yang sedang hidup membawa peran lama sampai kedaluwarsa —
// lihat AccessClaims di application/ports.ts.

import pg from 'pg'

const [email, flag] = process.argv.slice(2)
const role = flag === '--revoke' ? 'customer' : 'operator'

if (email === undefined || (flag !== undefined && flag !== '--revoke')) {
  process.stderr.write('pemakaian: operator:grant <surel> [--revoke]\n')
  process.exit(2)
}

const url = process.env.DATABASE_URL
if (url === undefined || url.length === 0) {
  process.stderr.write('DATABASE_URL wajib diisi\n')
  process.exit(2)
}

const client = new pg.Client({ connectionString: url })
await client.connect()
try {
  // Surel disimpan ternormalisasi huruf kecil (domain/email.ts).
  const result = await client.query(
    'UPDATE users SET role = $1::user_role, updated_at = now() WHERE email = $2',
    [role, email.trim().toLowerCase()],
  )
  if (result.rowCount !== 1) {
    // Gagal keras: akun yang salah ketik tidak boleh tampak "berhasil".
    process.stderr.write(`tidak ada akun dengan surel ${email}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(`${email} sekarang ${role}\n`)
  }
} finally {
  await client.end()
}
