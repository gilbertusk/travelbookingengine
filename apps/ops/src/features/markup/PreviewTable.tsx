import { Alert, AlertDescription } from '@tbe/ui/alert'
import { money } from '@/lib/format'
import type { Preview } from './schema'

type Side = Preview['rows'][number]['before']

function describe(side: Side): string {
  return side.ok ? money(side.total) : `gagal (${side.error.kind})`
}

/** Hasil pratinjau: harga sebelum dan sesudah, per sampel. */
export function PreviewTable({ preview }: { readonly preview: Preview }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-small">
        {preview.changedCount} dari {preview.rows.length} sampel berubah harga.
      </p>
      {preview.isTieBreakUncertain && (
        <Alert variant="warning">
          <AlertDescription>
            Aturan ini seri dengan aturan aktif lain (prioritas dan cakupan sama). Aturan mana yang
            menang ditentukan pengenalnya setelah disimpan — naikkan prioritas supaya pasti.
          </AlertDescription>
        </Alert>
      )}
      <table className="w-full text-small">
        <caption className="sr-only">Pratinjau dampak aturan</caption>
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="p-2">Sampel</th>
            <th className="p-2">Sebelum</th>
            <th className="p-2">Sesudah</th>
          </tr>
        </thead>
        <tbody>
          {preview.rows.map((row) => (
            <tr key={row.ref} className={row.isChanged ? 'border-t font-medium' : 'border-t'}>
              <td className="p-2">{row.ref}</td>
              <td className="p-2" data-numeric>
                {describe(row.before)}
              </td>
              <td className="p-2" data-numeric>
                {describe(row.after)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
