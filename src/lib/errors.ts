export function messageOf(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : cause && typeof cause === "object" && "message" in cause ? String(cause.message) : "Não foi possível concluir a ação. Tente novamente.";
  if (/duplicate|unique|deadlock|serialize/i.test(raw)) return "Este capítulo acabou de mudar. Atualize a página e tente novamente.";
  if (/permission|permissão|policy|row-level/i.test(raw)) return "Você não tem permissão para executar esta ação.";
  if (/último administrador|last admin/i.test(raw)) return "O último administrador ativo não pode perder acesso.";
  if (/Failed to fetch|NetworkError|timeout/i.test(raw)) return "A conexão foi interrompida. Confira sua internet e tente novamente.";
  if (/foreign key|constraint|invalid input|relation .* does not exist|function .* does not exist/i.test(raw)) {
    if (import.meta.env.DEV) console.error("Falha na operação", cause);
    return "Não foi possível salvar esta alteração. Atualize a página e tente novamente.";
  }
  return raw;
}
