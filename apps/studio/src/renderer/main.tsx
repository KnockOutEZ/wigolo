import { createRoot } from 'react-dom/client';
import { installTokens, followSystemRegister } from './theme';
import { App } from './App';

// The token layer goes in before the first render so nothing paints against unresolved custom
// properties, and the register follows the system appearance from then on — a change repaints the
// live app rather than reloading it.
installTokens();
followSystemRegister();

createRoot(document.getElementById('root')!).render(<App />);
