import "./App.css"
import { AuthorizationCard } from "./components/AuthorizationCard.js"
import { ConnectWallet } from "./components/ConnectWallet.js"
import { GuardCard } from "./components/GuardCard.js"
import { PolicyChat } from "./components/PolicyChat.js"
import { PolicyPanel } from "./components/PolicyPanel.js"
import { RiskFeedCard } from "./components/RiskFeedCard.js"
import { SafeCard } from "./components/SafeCard.js"
import { SimulateAttackCard } from "./components/SimulateAttackCard.js"
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
        <SafeCard />
        <GuardCard />
        <RiskFeedCard />
        <PolicyPanel />
        <SimulateAttackCard />
        <AuthorizationCard />
      </main>
      <PolicyChat />
    </div>
  )
}

export default App
