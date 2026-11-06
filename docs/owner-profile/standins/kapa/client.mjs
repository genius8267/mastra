// Owner-authored compatibility only. No chat UI or external service is created.
const disabledChat = Object.freeze({ toggle() {}, triggerRef: { current: null } })
export function DocsChatProvider({ children }) {
  return children
}
export function KapaChatProvider({ children }) {
  return children
}
export function useDocsChat() {
  return disabledChat
}
