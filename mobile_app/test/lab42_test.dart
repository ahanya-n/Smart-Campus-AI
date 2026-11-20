import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:smart_campus_app/lab42.dart' as lab42;

void main() {
  testWidgets('profile card fits a narrow screen and can scroll', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 480);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(const lab42.MyApp());
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    expect(find.text('Dinesh N'), findsOneWidget);
  });
}
