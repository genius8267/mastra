import type { ReactNode } from 'react'
export function DocsChatProvider(props: { children?: ReactNode }): ReactNode
export function KapaChatProvider(props: { children?: ReactNode }): ReactNode
export function useDocsChat(): { toggle(): void; triggerRef: { current: HTMLButtonElement | null } }
