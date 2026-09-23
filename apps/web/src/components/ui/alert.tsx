import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/cn'

/**
 * Alert.
 *
 * `role="alert"` hanya dipasang pada varian destructive: peran itu menyela
 * pembaca layar seketika, dan menyela untuk pemberitahuan biasa membuat
 * pengguna pembaca layar kehilangan tempatnya di halaman tanpa alasan.
 */
const alertVariants = cva('flex gap-3 rounded-lg border p-4 text-small', {
  variants: {
    variant: {
      info: 'border-border bg-muted/60 text-foreground',
      warning: 'border-warning/35 bg-warning/10 text-foreground',
      destructive: 'border-destructive/35 bg-destructive/8 text-foreground',
    },
  },
  defaultVariants: { variant: 'info' },
})

export type AlertProps = ComponentProps<'div'> & VariantProps<typeof alertVariants>

export function Alert({ className, variant = 'info', ...props }: AlertProps) {
  return (
    <div
      role={variant === 'destructive' ? 'alert' : 'status'}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
}

export function AlertTitle({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('font-medium', className)} {...props} />
}

export function AlertDescription({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('text-muted-foreground', className)} {...props} />
}
