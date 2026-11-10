import { installFullscreen } from './fullscreen'
import './style.css'
import { route, startRouter } from './router'
import { homeScreen } from './screens/home'
import { lobbyScreen } from './screens/lobby'
import { trainingScreen } from './screens/training'

route(/^\/$/, homeScreen)
route(/^\/training\/?$/, trainingScreen)
route(/^\/lobby\/([A-Za-z0-9]{6})\/?$/, lobbyScreen)

installFullscreen()

startRouter(document.getElementById('app')!)
