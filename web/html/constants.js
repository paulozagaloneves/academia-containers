// configurações globais do app.js
// endpoints das APIs 
// Semana 1: hardcoded para desenvolvimento local (docker-compose)
// Semana 2: via Ingress (k8s) - sobrescrever ficheiro via ConfigMap para definir um host diferente e/ou path diferente, 
//           exemplo: api.tipsbank.local/contas, api.tipsbank.local/transacoes, api.tipsbank.local/auditoria

const API = {
  contas: "/api/contas",
  transacoes: "/api/transacoes",
  auditoria: "/api/auditoria",
};