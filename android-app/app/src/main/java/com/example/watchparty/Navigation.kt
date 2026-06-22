package com.example.watchparty

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberNavBackStack
import androidx.navigation3.ui.NavDisplay
import com.example.watchparty.ui.main.MainScreen
import com.example.watchparty.ui.f1.F1Screen
import com.example.watchparty.ui.fifa.FifaScreen
import com.example.watchparty.ui.splash.SplashScreen

@Composable
fun MainNavigation() {
  val backStack = rememberNavBackStack(Splash)

  NavDisplay(
    backStack = backStack,
    onBack = { backStack.removeLastOrNull() },
    entryProvider =
      entryProvider {
        entry<Splash> {
          SplashScreen(
            onAnimationFinished = {
              backStack.add(Main)
              backStack.remove(Splash)
            },
            modifier = Modifier.fillMaxSize()
          )
        }
        entry<Main> {
          MainScreen(onItemClick = { navKey -> backStack.add(navKey) }, modifier = Modifier.fillMaxSize())
        }
        entry<F1> {
          F1Screen(onBackClick = { backStack.removeLastOrNull() }, modifier = Modifier.fillMaxSize())
        }
        entry<Fifa> {
          FifaScreen(onBackClick = { backStack.removeLastOrNull() }, modifier = Modifier.fillMaxSize())
        }
      },
  )
}
