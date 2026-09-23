'use client'

import { AlertTriangle, Inbox, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { DateRange } from 'react-day-picker'
import { EmptyState, ErrorState, LoadingState } from '@/components/state/states'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toast } from '@/components/ui/toaster'

const BUTTON_VARIANTS = ['primary', 'secondary', 'ghost', 'destructive'] as const
const BADGE_VARIANTS = [
  'neutral',
  'outline',
  'primary',
  'success',
  'warning',
  'destructive',
] as const

export function ButtonShowcase() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        {BUTTON_VARIANTS.map((variant) => (
          <Button key={variant} variant={variant}>
            {variant}
          </Button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm">sm</Button>
        <Button size="md">md</Button>
        <Button size="lg">lg</Button>
        <Button size="icon" aria-label="Hapus">
          <Trash2 />
        </Button>
        <Button disabled>nonaktif</Button>
      </div>
    </div>
  )
}

export function BadgeShowcase() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {BADGE_VARIANTS.map((variant) => (
        <Badge key={variant} variant={variant}>
          {variant}
        </Badge>
      ))}
    </div>
  )
}

export function FormShowcase() {
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <div className="flex flex-col gap-2">
        <Label htmlFor="ds-input">Label sungguhan</Label>
        <Input id="ds-input" placeholder="Placeholder bukan pengganti label" />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="ds-input-invalid">Bidang bermasalah</Label>
        <Input id="ds-input-invalid" aria-invalid defaultValue="nilai@salah" />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="ds-select">Select</Label>
        <Select defaultValue="2">
          <SelectTrigger id="ds-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1">Satu tamu</SelectItem>
            <SelectItem value="2">Dua tamu</SelectItem>
            <SelectItem value="3">Tiga tamu</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="ds-input-disabled">Nonaktif</Label>
        <Input id="ds-input-disabled" disabled defaultValue="Tidak dapat diubah" />
      </div>
    </div>
  )
}

export function OverlayShowcase() {
  const [range, setRange] = useState<DateRange | undefined>(undefined)

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Dialog>
        <DialogTrigger asChild>
          <Button>Dialog</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Harga berubah</DialogTitle>
            <DialogDescription>
              Penyedia memperbarui tarif untuk tanggal yang kamu pilih sebelum pembayaran selesai.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary">Batal</Button>
            <Button variant="primary">Terima harga baru</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Sheet>
        <SheetTrigger asChild>
          <Button>Sheet</Button>
        </SheetTrigger>
        <SheetContent side="right">
          <SheetHeader>
            <SheetTitle>Filter</SheetTitle>
            <SheetDescription>Di mobile, panel ini muncul dari bawah layar.</SheetDescription>
          </SheetHeader>
        </SheetContent>
      </Sheet>

      <Popover>
        <PopoverTrigger asChild>
          <Button>Popover + Calendar</Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0">
          <Calendar mode="range" numberOfMonths={1} selected={range} onSelect={setRange} />
        </PopoverContent>
      </Popover>

      <Button
        onClick={() => {
          toast.success('Tersimpan', { description: 'Toast memakai token yang sama.' })
        }}
      >
        Toast
      </Button>
    </div>
  )
}

export function FeedbackShowcase() {
  return (
    <div className="flex flex-col gap-4">
      <Alert variant="info">
        <AlertTitle>3 dari 5 penyedia sudah menjawab</AlertTitle>
        <AlertDescription>Hasil akan bertambah saat sisanya masuk.</AlertDescription>
      </Alert>

      <Alert variant="warning">
        <AlertTitle>Penahanan harga tersisa 4 menit</AlertTitle>
        <AlertDescription>Selesaikan pembayaran sebelum waktunya habis.</AlertDescription>
      </Alert>

      <Alert variant="destructive">
        <AlertTitle>Pembayaran ditolak</AlertTitle>
        <AlertDescription>Kartu tidak dapat diproses. Coba metode lain.</AlertDescription>
      </Alert>
    </div>
  )
}

export function StructureShowcase() {
  return (
    <div className="flex flex-col gap-8">
      <Card className="max-w-md">
        <CardHeader>
          <CardTitle>Kartu tanpa bayangan</CardTitle>
          <CardDescription>Dibedakan dengan border, bukan elevasi.</CardDescription>
        </CardHeader>
        <CardContent className="text-small text-muted-foreground">
          Padding 20px. Kartu tidak pernah disarangkan di dalam kartu lain.
        </CardContent>
      </Card>

      <Tabs defaultValue="ringkasan">
        <TabsList>
          <TabsTrigger value="ringkasan">Ringkasan</TabsTrigger>
          <TabsTrigger value="kebijakan">Kebijakan</TabsTrigger>
          <TabsTrigger value="ulasan" disabled>
            Ulasan
          </TabsTrigger>
        </TabsList>
        <TabsContent value="ringkasan" className="text-small text-muted-foreground">
          Tab terpilih ditandai garis dan warna, bukan warna saja.
        </TabsContent>
        <TabsContent value="kebijakan" className="text-small text-muted-foreground">
          Kebijakan pembatalan selalu terlihat tanpa perlu diklik.
        </TabsContent>
      </Tabs>

      <div className="flex items-center gap-4 text-small text-muted-foreground">
        <span>Kiri</span>
        <Separator orientation="vertical" className="h-4" />
        <span>Kanan</span>
      </div>
    </div>
  )
}

export function StatesShowcase() {
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="rounded-lg border border-border p-5">
        <p className="mb-4 text-caption font-medium text-muted-foreground">Memuat</p>
        <LoadingState>
          <div className="flex flex-col gap-3">
            <Skeleton className="aspect-4/3 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        </LoadingState>
      </div>

      <div className="rounded-lg border border-border">
        <EmptyState
          icon={<Inbox />}
          title="Tidak ada hasil"
          description="Coba ubah tanggal atau perluas daerah pencarian."
          action={<Button variant="secondary">Ubah pencarian</Button>}
        />
      </div>

      <div className="rounded-lg border border-border">
        <ErrorState
          icon={<AlertTriangle />}
          title="Gagal memuat"
          description="Layanan pencarian tidak menjawab. Coba lagi sebentar lagi."
          action={<Button variant="secondary">Coba lagi</Button>}
        />
      </div>
    </div>
  )
}
