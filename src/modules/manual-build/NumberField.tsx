import { useState } from 'react'

interface NumberFieldProps {
  className?: string
  value: number
  step: number
  min?: number
  max?: number
  onCommit: (value: number) => void
}

export function NumberField({ className, value, step, min, max, onCommit }: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <input
      className={className}
      type="number"
      step={step}
      min={min}
      max={max}
      value={draft ?? value}
      onChange={event => setDraft(event.target.value)}
      onBlur={event => {
        setDraft(null)
        const next = event.currentTarget.valueAsNumber
        if (Number.isFinite(next) && next !== value && next >= (min ?? -Infinity) && next <= (max ?? Infinity)) {
          onCommit(next)
        }
      }}
      onKeyDown={event => {
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
    />
  )
}
