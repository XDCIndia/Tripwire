import "./App.css"
import { ActionAuthCard } from "./components/ActionAuthCard.js"
import { BatchRiskCard } from "./components/BatchRiskCard.js"
import { AuthorizationCard } from "./components/AuthorizationCard.js"
import { AuditCard } from "./components/AuditCard.js"
import { ConnectWallet } from "./components/ConnectWallet.js"
import { EvidenceExplorerCard } from "./components/EvidenceExplorerCard.js"
import { GuardCard } from "./components/GuardCard.js"
import { NonceConflictCard } from "./components/NonceConflictCard.js"
import { RiskDecisionCard } from "./components/RiskDecisionCard.js"
import { PolicyChat } from "./components/PolicyChat.js"
import { PolicyPanel } from "./components/PolicyPanel.js"
import { RiskFeedCard } from "./components/RiskFeedCard.js"
import { SafeCard } from "./components/SafeCard.js"
import { SecurityTimelineCard } from "./components/SecurityTimelineCard.js"
import { SecurityHealthCard } from "./components/SecurityHealthCard.js"
import { SimulateAttackCard } from "./components/SimulateAttackCard.js"
import { SimulationIntegrityCard } from "./components/SimulationIntegrityCard.js"
import { SimulationCard } from "./components/SimulationCard.js"
import { VerificationStatusCard } from "./components/VerificationStatusCard.js"
import { activeChain } from "./config.js"

export function App() {
  return (
    <div className="app">
      <header className="topbar">
        <div>
          <span className="brand">Tripwire</span>
          <span className="chain-pill">{activeChain.name}</span>
        </div>
        <ConnectWallet />
      </header>
      <main className="grid">
        <SecurityHealthCard />
        <VerificationStatusCard />
        <SafeCard />
        <GuardCard />
        <AuditCard />
        <RiskFeedCard />
        <EvidenceExplorerCard />
        <ActionAuthCard />
        <SecurityTimelineCard />
        <RiskDecisionCard />
        <PolicyPanel />
        <SimulateAttackCard />
        <BatchRiskCard />
        <SimulationIntegrityCard />
        <AuthorizationCard />
        <NonceConflictCard />
        <SimulationCard />
      </main>
      <PolicyChat />
    </div>
  )
}

export default App
