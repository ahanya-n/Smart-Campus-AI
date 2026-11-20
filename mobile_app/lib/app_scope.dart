import 'package:flutter/widgets.dart';

import 'services/api_service.dart';
import 'services/auth_controller.dart';

/// Makes the shared [ApiService] and [AuthController] available to every screen.
class AppScope extends InheritedWidget {
  const AppScope({
    super.key,
    required this.api,
    required this.auth,
    required super.child,
  });

  final ApiService api;
  final AuthController auth;

  /// Use in `build` methods.
  static AppScope of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<AppScope>();
    assert(scope != null, 'No AppScope found in context');
    return scope!;
  }

  /// Use in `initState` and callbacks.
  static AppScope read(BuildContext context) {
    final scope = context.getInheritedWidgetOfExactType<AppScope>();
    assert(scope != null, 'No AppScope found in context');
    return scope!;
  }

  @override
  bool updateShouldNotify(AppScope oldWidget) =>
      api != oldWidget.api || auth != oldWidget.auth;
}
