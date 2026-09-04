import "./App.css"
import { AuditCard } from "./components/AuditCard.js"
import { ConnectWallet } from "./components/ConnectWallet.js"
import { GuardCard } from "./components/GuardCard.js"
import { RiskDecisionCard } from "./components/RiskDecisionCard.js"
import { PolicyChat } from "./components/PolicyChat.js"
import { PolicyPanel } from "./components/PolicyPanel.js"
import { RiskFeedCard } from "./components/RiskFeedCard.js"
import { SafeCard } from "./components/SafeCard.js"
import { SecurityTimelineCard } from "./components/SecurityTimelineCard.js"
import { SimulateAttackCard } from "./components/SimulateAttackCard.js"
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
        <VerificationStatusCard />
        <SafeCard />
        <GuardCard />
        <AuditCard />
        <RiskFeedCard />
        <SecurityTimelineCard />
        <RiskDecisionCard />
        <PolicyPanel />
        <SimulateAttackCard />
        <SimulationCard />
      </main>
      <PolicyChat />
    </div>
  )
}

export default App
