# syntax=docker/dockerfile:1.7

# =============================================================================
# TipsBank — auditoria (.NET 10) — Dockerfile EXEMPLO
#
# Estrutura esperada (ajusta os caminhos se a tua solução for diferente):
#   auditoria/
#   ├── Dockerfile
#   └── src/Auditoria/Auditoria.csproj
#
# Build:  docker build -t tipsbank-auditoria:v1.0.0 ./auditoria
# =============================================================================

# =============================================================================
# STAGE 1 — build (SDK completo: compilador, NuGet, ferramentas)
# =============================================================================
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

# 1) Copiar só o .csproj e fazer restore -> esta camada fica em cache enquanto
#    as dependências NuGet não mudarem (builds seguintes muito mais rápidos).
COPY src/Auditoria/Auditoria.csproj src/Auditoria/
RUN dotnet restore src/Auditoria/Auditoria.csproj

# 2) Copiar o resto do código e publicar em Release.
COPY src/ src/
RUN dotnet publish src/Auditoria/Auditoria.csproj \
      -c Release \
      -o /app/publish \
      --no-restore \
      /p:UseAppHost=false

# =============================================================================
# STAGE 2 — runtime "chiseled" (equivalente .NET ao Distroless):
#   - Ubuntu Noble reduzido ao mínimo: sem shell, sem package manager
#   - utilizador não-root "app" (UID/GID 1654) já criado na imagem
#   - só o runtime ASP.NET Core (sem SDK)
# =============================================================================
FROM mcr.microsoft.com/dotnet/aspnet:10.0-noble-chiseled AS runtime
WORKDIR /app

COPY --from=build /app/publish .

ENV ASPNETCORE_HTTP_PORTS=8080 \
    DOTNET_EnableDiagnostics=0 \
    DOTNET_gcServer=0 \
    DATA_DIR=/data

EXPOSE 8080

# $APP_UID (1654) é definido pela imagem base da Microsoft.
USER $APP_UID

ENTRYPOINT ["dotnet", "Auditoria.dll"]

# =============================================================================
# VARIANTE OPCIONAL — Native AOT (imagem ainda menor, arranque mais rápido)
# Requer <PublishAot>true</PublishAot> no .csproj e código compatível com AOT
# (System.Text.Json com source generators, sem reflection dinâmica).
#
# FROM mcr.microsoft.com/dotnet/sdk:10.0-noble-aot AS build-aot
# ... dotnet publish -c Release -r linux-x64 -o /app/publish
# FROM mcr.microsoft.com/dotnet/runtime-deps:10.0-noble-chiseled
# COPY --from=build-aot /app/publish .
# USER $APP_UID
# ENTRYPOINT ["./Auditoria"]
# =============================================================================
