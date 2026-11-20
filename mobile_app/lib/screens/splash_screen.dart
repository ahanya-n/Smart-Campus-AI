import 'package:flutter/material.dart';

import '../app_scope.dart';
import '../services/api_service.dart';

/// Shown on app start while a saved session is checked against GET /me.
class SplashScreen extends StatefulWidget {
  const SplashScreen({super.key});

  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen> {
  String? _error;

  @override
  void initState() {
    super.initState();
    _restore();
  }

  Future<void> _restore() async {
    setState(() => _error = null);
    final auth = AppScope.read(context).auth;
    debugPrint('[startup] splash session restore started');

    try {
      // Keep the splash visible briefly so it doesn't flash.
      await Future.wait([
        auth.restoreSession(),
        Future<void>.delayed(const Duration(milliseconds: 800)),
      ]);
      debugPrint('[startup] splash session restore completed');
    } on ApiException catch (e) {
      debugPrint('[startup] splash session restore failed: ${e.runtimeType}');
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      debugPrint('[startup] splash session restore failed unexpectedly');
      if (mounted) {
        setState(() => _error = 'Something went wrong while starting the app.');
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    debugPrint('[startup] SplashScreen building');
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final onPrimary = scheme.onPrimary;

    return Scaffold(
      body: Container(
        width: double.infinity,
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [scheme.primary, Color.lerp(scheme.primary, Colors.black, 0.35)!],
          ),
        ),
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Container(
                  width: 96,
                  height: 96,
                  decoration: BoxDecoration(
                    color: onPrimary.withValues(alpha: 0.15),
                    borderRadius: BorderRadius.circular(28),
                  ),
                  child: Icon(Icons.school_rounded, size: 56, color: onPrimary),
                ),
                const SizedBox(height: 24),
                Text(
                  'Smart Campus',
                  style: theme.textTheme.headlineMedium?.copyWith(
                    color: onPrimary,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  'Campus management, simplified',
                  style: theme.textTheme.bodyLarge
                      ?.copyWith(color: onPrimary.withValues(alpha: 0.8)),
                ),
                const SizedBox(height: 48),
                if (_error == null)
                  SizedBox(
                    width: 28,
                    height: 28,
                    child: CircularProgressIndicator(
                      strokeWidth: 3,
                      color: onPrimary,
                    ),
                  )
                else
                  _SplashError(
                    message: _error!,
                    onRetry: _restore,
                    onSignOut: () => AppScope.read(context).auth.logout(),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _SplashError extends StatelessWidget {
  const _SplashError({
    required this.message,
    required this.onRetry,
    required this.onSignOut,
  });

  final String message;
  final VoidCallback onRetry;
  final VoidCallback onSignOut;

  @override
  Widget build(BuildContext context) {
    final onPrimary = Theme.of(context).colorScheme.onPrimary;

    return Column(
      children: [
        Icon(Icons.cloud_off_rounded, color: onPrimary, size: 36),
        const SizedBox(height: 12),
        Text(
          message,
          textAlign: TextAlign.center,
          style: TextStyle(color: onPrimary),
        ),
        const SizedBox(height: 20),
        FilledButton.icon(
          style: FilledButton.styleFrom(
            backgroundColor: onPrimary,
            foregroundColor: Theme.of(context).colorScheme.primary,
          ),
          onPressed: onRetry,
          icon: const Icon(Icons.refresh_rounded),
          label: const Text('Try again'),
        ),
        TextButton(
          onPressed: onSignOut,
          style: TextButton.styleFrom(foregroundColor: onPrimary),
          child: const Text('Sign out'),
        ),
      ],
    );
  }
}
