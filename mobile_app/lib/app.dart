import 'package:flutter/material.dart';

import 'app_scope.dart';
import 'screens/home_shell.dart';
import 'screens/login_screen.dart';
import 'screens/splash_screen.dart';
import 'services/api_service.dart';
import 'services/auth_controller.dart';
import 'theme/app_theme.dart';

class SmartCampusApp extends StatelessWidget {
  const SmartCampusApp({super.key, required this.api, required this.auth});

  final ApiService api;
  final AuthController auth;

  @override
  Widget build(BuildContext context) {
    return AppScope(
      api: api,
      auth: auth,
      child: MaterialApp(
        title: 'Smart Campus',
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light,
        darkTheme: AppTheme.dark,
        home: const AuthGate(),
      ),
    );
  }
}

/// Shows the splash, login or home screen depending on the sign-in state.
class AuthGate extends StatefulWidget {
  const AuthGate({super.key});

  @override
  State<AuthGate> createState() => _AuthGateState();
}

class _AuthGateState extends State<AuthGate> {
  late final AuthController _auth;
  late AuthStatus _lastStatus;

  @override
  void initState() {
    super.initState();
    _auth = AppScope.read(context).auth;
    _lastStatus = _auth.status;
    debugPrint('[startup] AuthGate initialized: ${_auth.status.name}');
    _auth.addListener(_onAuthChanged);
  }

  @override
  void dispose() {
    _auth.removeListener(_onAuthChanged);
    super.dispose();
  }

  void _onAuthChanged() {
    if (_auth.status == _lastStatus) {
      setState(() {});
      return;
    }
    _lastStatus = _auth.status;
    // Close screens pushed on top (e.g. Register) when signing in or out.
    Navigator.of(context).popUntil((route) => route.isFirst);
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    debugPrint('[startup] AuthGate building: ${_auth.status.name}');
    final Widget screen = switch (_auth.status) {
      AuthStatus.unknown => const SplashScreen(),
      AuthStatus.unauthenticated => const LoginScreen(),
      AuthStatus.authenticated => const HomeShell(),
    };

    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 300),
      child: KeyedSubtree(key: ValueKey(_auth.status), child: screen),
    );
  }
}
