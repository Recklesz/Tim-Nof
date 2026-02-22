import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import WimHofBreathing from './WimHofBreathing'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <WimHofBreathing />
  </StrictMode>,
)
