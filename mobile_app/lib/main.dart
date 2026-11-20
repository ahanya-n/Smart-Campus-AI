import 'package:flutter/material.dart';

import 'app.dart';
import 'services/api_service.dart';
import 'services/auth_controller.dart';
import 'services/token_storage.dart';

void main() {
  debugPrint('[startup] main entered');
  WidgetsFlutterBinding.ensureInitialized();
  WidgetsBinding.instance.addPostFrameCallback(
    (_) => debugPrint('[startup] first Flutter frame completed'),
  );

  final tokenStorage = SecureTokenStorage();
  final api = ApiService(tokenStorage: tokenStorage);
  final auth = AuthController(api: api, tokenStorage: tokenStorage);

  debugPrint('[startup] calling runApp');
  runApp(SmartCampusApp(api: api, auth: auth));
}
